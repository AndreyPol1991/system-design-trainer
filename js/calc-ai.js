/* ИИ-расчёт: «Как посчитать» для уровней с языковой моделью и лаборатория «Оценка на салфетке: ИИ».
   Файл грузится по требованию: запись-оглавление estai в js/labs-lazy.js, его же подгружает SD.calc.openAi (js/calc.js).
   Мысль одна. Обычный сервис отвечает за миллисекунды, модель — секунды: она печатает ответ слово за словом.
   Поэтому считают не «запросов в секунду», а «разговоров одновременно»: одновременно = поток × время ответа (закон Литтла).
   Именно разговоры упираются в сервер модели: каждому нужен черновик в видеопамяти и доля скорости видеокарты.
   Отсюда — сколько серверов модели или какой лимит у поставщика, поток (SSE) или очередь, пачка и цена токенов.
   Сколько вопросов доходит до модели и сколько тянет видеокарта по скорости — берём у симулятора на эталоне уровня;
   память симулятор не моделирует — её считаем формулой (тут расчёт строже симулятора). */
(function () {
  if (SD.calcAi) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const F = () => SD.fmt;
  const TARGET = 0.75, MONTH = 2.63e6, WPT = 1.5, GPU_GB = 80, SPARE = 0.9, RUB = 90;
  /* веса модели и черновик разговора (KV-кэш) на токен — ориентиры 2026 года для класса модели из SD.LLM_SIZES */
  const MEM = {
    small: { w: 16, kv: 0.13, what: '8B в BF16' },
    medium: { w: 70, kv: 0.32, what: '70B в FP8' },
    large: { w: 405, kv: 0.5, what: '≈ 400B в FP8' }
  };
  const SEM = { '0.98': 0.45, '0.95': 0.75, '0.90': 0.92 };
  const aiOf = L => Object.assign({ inTok: 800, outTok: 300, ragTok: 2500, repeat: 0.3, audioSec: 5, steps: 4, agentOut: 150, simple: 0.7 }, (L && L.ai) || {});
  const comma = s => String(s).replace('.', ',');
  const num = v => { if (!isFinite(v)) return '∞'; const a = Math.abs(v); return a >= 100 ? Math.round(v).toLocaleString('ru-RU') : a >= 10 ? String(Math.round(v)) : comma((Math.round(v * 10) / 10).toString()); };
  const fx = v => !isFinite(v) ? '∞' : Math.abs(v) >= 10 ? num(v) : Math.abs(v) >= 1 ? comma(v.toFixed(1)) : comma(v.toFixed(2));
  const sec = v => fx(v) + ' с';
  const usd = v => F().usd(v);
  const pct = v => Math.round(v * 100) + ' %';
  const plural = (n, f) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? f[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? f[1] : f[2]; };
  const SRV = ['сервер', 'сервера', 'серверов'], GPUW = ['видеокарта', 'видеокарты', 'видеокарт'];
  /* слово после числа так, как число показано: «2,4 вопроса», «3 вопроса», «64 разговора» */
  const plS = (s, f) => /,/.test(s) ? f[1] : plural(parseInt(String(s).replace(/\s/g, ''), 10) || 0, f);
  const pn = (v, f, fm) => { const s = (fm || num)(v); return s + ' ' + plS(s, f); };
  const QW = ['вопрос', 'вопроса', 'вопросов'], CW = ['вызов', 'вызова', 'вызовов'], DW = ['разговор', 'разговора', 'разговоров'], TW = ['токен', 'токена', 'токенов'], ZW = ['запрос', 'запроса', 'запросов'], PW = ['место', 'места', 'мест'];
  const gbf = v => v < 10 ? comma(v.toFixed(2)) : fx(v);
  const nm = n => n.label || (SD.TYPES[n.type] || {}).name || n.type;
  const sizeOf = n => SD.LLM_SIZES[n.props.size] ? n.props.size : 'medium';
  const sizeShort = { small: 'малая', medium: 'средняя', large: 'большая' };

  /* ---------- «На пальцах»: общая карточка для расчёта и лаборатории ---------- */
  const FG = {
    title: 'долгий ответ модели',
    thesis: 'Обычный сервис отвечает за доли секунды, а языковая модель — за секунды: она печатает ответ слово за словом. Поэтому важно не то, сколько вопросов приходит в секунду, а сколько разговоров идёт одновременно: каждому нужно своё место на сервере модели.',
    analogy: 'Кассир, который говорит медленно: очередь растёт не от числа покупателей, а от длины разговора. Пять покупателей в минуту по полминуты каждый — это три кассы. Те же пять покупателей по пять минут — уже двадцать пять касс. Касса занята, пока идёт разговор, а у прилавка помещается ограниченное число покупателей. Длинный разговор можно вести и иначе: «говорите — я сразу записываю» или выдать талончик «мы вам позвоним».',
    picture: () => picture(),
    map: [
      ['Покупатели в минуту', 'RPS — вопросов в секунду', 'сколько вопросов приходит; для модели это ещё не нагрузка'],
      ['Длина разговора', 'время ответа = TTFT + токены ÷ скорость', 'TTFT — пауза до первого слова; дальше модель печатает 40–160 токенов в секунду'],
      ['Занятые кассы', 'одновременных генераций (закон Литтла)', 'одновременно = поток × время: 3 вопроса/с × 4 с = 12 разговоров'],
      ['Прилавок у кассы', 'видеопамять сервера', 'под каждый разговор — свой черновик (KV-кэш): контекст × размер на токен; и скорость видеокарты делится на всех'],
      ['Сколько касс открыть', 'серверов (реплик) модели или лимит у поставщика', 'разговоров ÷ (мест на сервере × 0,75)'],
      ['«Говорите — я сразу пишу»', 'поток ответа (SSE)', 'первое слово через доли секунды, остальное бежит на глазах'],
      ['Талончик «мы вам позвоним»', 'очередь задач с уведомлением', 'для долгого: агент в несколько шагов, разбор документа, отчёт']
    ]
  };
  /* картинка: предметы аналогии с терминами; data-lf-k — номер пары в map */
  function picture() {
    const BW = 172, BH = 46;
    const wid = (s, px, k) => [...s].reduce((w, c) => w + px * (/\s/.test(c) ? 0.28 : /[.,:;«»()—–-]/.test(c) ? 0.4 : /[А-ЯЁA-Z]/.test(c) ? 0.72 : /[шщмжюыфШЩМЖЮЫФ]/.test(c) ? 0.8 : k), 0);
    const fit = (cls, x, y, s, px, avail, k) => `<text class="${cls}" x="${x}" y="${y}"${wid(s, px, k) > avail ? ` textLength="${avail}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(s)}</text>`;
    const box = (i, x, y, a, t) => `<g class="lf-fg-it" data-lf-k="${i}"><rect class="lf-fg-box" x="${x}" y="${y}" width="${BW}" height="${BH}" rx="9"/>${fit('lf-fg-ta', x + 10, y + 19, a, 13, BW - 18, 0.6)}${fit('lf-fg-tt', x + 10, y + 37, t, 12.5, BW - 18, 0.56)}</g>`;
    const head = (x1, y1, x2, y2) => { const a = Math.atan2(y2 - y1, x2 - x1), s = 6, r = v => Math.round(v * 10) / 10; return `<path class="lf-fg-ah" d="M${r(x2)} ${r(y2)}L${r(x2 - s * Math.cos(a - 0.45))} ${r(y2 - s * Math.sin(a - 0.45))}L${r(x2 - s * Math.cos(a + 0.45))} ${r(y2 - s * Math.sin(a + 0.45))}Z"/>`; };
    const arr = (x1, y1, x2, y2) => `<g class="lf-fg-ar"><path d="M${x1} ${y1}L${x2} ${y2}"/>${head(x1, y1, x2, y2)}</g>`;
    const tag = (x, y, t, cls, anchor) => `<text class="lf-fg-tag${cls ? ' ' + cls : ''}" x="${x}" y="${y}"${anchor ? ` text-anchor="${anchor}"` : ''}>${esc(t)}</text>`;
    const L = 'Покупатели в минуту и длина разговора дают число занятых касс; оно вместе с прилавком решает, сколько касс открыть; отдавать ответ можно потоком или талончиком';
    return `<svg class="lf-fg-svg" viewBox="0 0 360 284" style="max-width:400px;margin:0 auto" role="img" aria-label="${esc(L)}">`
      + box(0, 2, 4, 'Покупатели в минуту', 'RPS (вопросов/с)') + box(1, 186, 4, 'Длина разговора', 'время ответа')
      + arr(88, 51, 88, 76) + arr(250, 51, 160, 77) + tag(108, 69, '×', '', 'middle')
      + box(2, 2, 80, 'Занятые кассы', 'одновременных (Литтл)') + box(3, 186, 80, 'Прилавок у кассы', 'видеопамять сервера')
      + arr(88, 127, 150, 154) + arr(272, 127, 212, 154) + tag(180, 140, '÷ мест × 0,75', '', 'middle')
      + box(4, 94, 158, 'Сколько касс открыть', 'серверов модели')
      + tag(180, 226, 'что видит человек', 'lf-fg-zone', 'middle')
      + box(5, 2, 234, '«Говорите — я пишу»', 'поток (SSE)') + box(6, 186, 234, 'Талончик «позвоним»', 'очередь + уведомление')
      + '</svg>';
  }

  /* ---------- стили: только переменные темы из :root, обе темы ---------- */
  const CSS = `
.cai-lv { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12.5px; color: var(--text-muted); }
.cai-lv button { border: 1px solid var(--border); background: var(--surface); color: var(--text-2); border-radius: 999px; padding: 4px 10px; font-size: 12.5px; cursor: pointer; }
.cai-lv button:hover { border-color: var(--accent); color: var(--text); }
.cai-lv button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--text); font-weight: 600; }
.cai-pick { display: flex; flex-wrap: wrap; gap: 6px; }
.cai-pick .btn { padding: 6px 12px; font-size: 12.5px; white-space: normal; text-align: left; }
.cai-pick .btn[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
.cai-see { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); font-size: 12.5px; color: var(--text-2); line-height: 1.5; }
.cai-see b { color: var(--text); }
.cai-bar { position: relative; height: 10px; border-radius: 6px; background: var(--surface-3); overflow: hidden; }
.cai-bar i { position: absolute; top: 0; bottom: 0; left: 0; background: var(--accent); border-radius: 6px; }
.cai-bar i.wait { background: var(--border-strong); }
.cai-row { display: flex; justify-content: space-between; gap: 8px; font: 600 11.5px var(--f-mono); color: var(--text-muted); }
.cai-res-t { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
.cai-res-t td { padding: 3px 2px; border-bottom: 1px solid var(--border); vertical-align: top; }
.cai-res-t td:last-child { font-family: var(--f-mono); font-size: 11.5px; }
.calc-sum td small { display: block; color: var(--text-muted); font-size: 11.5px; }
#calcAiModal .sheet { min-width: 0; }
#calcAiSide .calc-act .btn { white-space: normal; text-align: center; }
#labMain:has(.eai) #labDive { white-space: normal; text-align: left; max-width: 100%; }
.eai { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.eai .lt-tabs { position: static; }
.eai-grid { display: grid; grid-template-columns: minmax(0, 330px) minmax(0, 1fr); gap: 14px; align-items: start; }
@media (max-width: 900px) { .eai-grid { grid-template-columns: minmax(0, 1fr); } }
.eai-ctl { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); min-width: 0; }
.eai-pre { display: flex; flex-wrap: wrap; gap: 4px; }
.eai-pre button { flex: 1 1 auto; border: 1px solid var(--border); background: var(--surface); color: var(--text-2); border-radius: 8px; padding: 6px 8px; font-size: 12.5px; cursor: pointer; }
.eai-pre button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--text); font-weight: 600; }
.eai-sl { display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; color: var(--text-2); }
.eai-sl > span { display: flex; justify-content: space-between; gap: 8px; }
.eai-sl output { font: 600 12.5px var(--f-mono); color: var(--text); white-space: nowrap; }
.eai-sl input[type="range"] { width: 100%; accent-color: var(--accent); margin: 2px 0 0; }
.eai-sl small { color: var(--text-muted); font-size: 11.5px; }
.eai-out { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.eai-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 6px; }
.eai-tile { padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.eai-tile small { color: var(--text-muted); font-size: 11.5px; }
.eai-tile b { font: 700 17px var(--f-mono); color: var(--text); overflow-wrap: anywhere; }
.eai-tile em { font-style: normal; font-size: 11.5px; color: var(--text-2); }
.eai-tile.bad { border-color: var(--bad); } .eai-tile.bad b { color: var(--bad); }
.eai-tile.warn { border-color: var(--warn); }
.eai-f { margin: 0; padding: 8px 10px 8px 26px; border-radius: 10px; background: var(--surface-2); font-size: 12.5px; color: var(--text-2); line-height: 1.6; }
.eai-f b { color: var(--text); }
.eai-seats { display: flex; flex-wrap: wrap; gap: 8px; }
.eai-srv { border: 1px solid var(--border-strong); border-radius: 8px; padding: 5px; display: grid; grid-template-columns: repeat(8, 9px); gap: 2px; background: var(--surface); }
.eai-srv i { width: 9px; height: 9px; border-radius: 2px; background: var(--surface-3); }
.eai-srv i.on { background: var(--accent); }
.eai-srv i.over { background: var(--bad); }
.eai-srv.wait { border-style: dashed; border-color: var(--bad); }
.eai-cap { margin: 0; font-size: 12px; color: var(--text-muted); }
.eai-mode { display: flex; flex-wrap: wrap; gap: 4px; }
.eai-mode button { border: 1px solid var(--border); background: var(--surface); color: var(--text-2); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; cursor: pointer; }
.eai-mode button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--text); font-weight: 600; }
.eai-view { display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 640px) { .eai-view { grid-template-columns: minmax(0, 1fr); } }
.eai-phone { border: 1px solid var(--border-strong); border-radius: 18px; padding: 12px 10px; background: var(--bg); display: flex; flex-direction: column; gap: 8px; min-height: 200px; }
.eai-msg { max-width: 92%; padding: 7px 10px; border-radius: 12px; font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
.eai-msg.me { align-self: flex-end; background: var(--accent-soft); color: var(--text); border-bottom-right-radius: 4px; }
.eai-msg.bot { align-self: flex-start; background: var(--surface-2); color: var(--text); border-bottom-left-radius: 4px; min-height: 18px; }
.eai-msg.note { align-self: stretch; max-width: none; background: var(--info-soft); color: var(--text); border-radius: 10px; display: flex; gap: 6px; align-items: flex-start; }
.eai-msg.note svg { flex: none; width: 16px; height: 16px; stroke: var(--info); fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; margin-top: 1px; }
.eai-dots { display: inline-flex; gap: 3px; } .eai-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--text-muted); animation: eaiDot 1s infinite ease-in-out; }
.eai-dots i:nth-child(2) { animation-delay: .15s; } .eai-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes eaiDot { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
html.calm .eai-dots i { animation: none; opacity: .7; }
.eai-tl { display: flex; flex-direction: column; gap: 4px; }
.eai-see { margin: 0; font-size: 12.5px; color: var(--text-2); line-height: 1.55; }
.eai-see b { color: var(--text); }
.eai-see.bad { color: var(--bad); }
.eai-ch { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.eai-chart { border: 1px solid var(--border); border-radius: 10px; padding: 8px 8px 4px; background: var(--surface); min-width: 0; }
.eai-chart h5 { margin: 0 0 2px; font-size: 12.5px; color: var(--text); font-weight: 600; }
.eai-chart svg { display: block; width: 100%; height: auto; touch-action: none; }
.eai-chart .ax { stroke: var(--border); stroke-width: 1; }
.eai-chart .tk { font: 500 10.5px var(--f-mono); fill: var(--text-muted); }
.eai-chart .ln { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.eai-chart .ln.a { stroke: var(--accent); } .eai-chart .ln.b { stroke: var(--info); }
.eai-chart .mk { stroke: var(--surface); stroke-width: 2; } .eai-chart .mk.a { fill: var(--accent); } .eai-chart .mk.b { fill: var(--info); }
.eai-chart .xh { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.eai-chart .vl { font: 600 11px var(--f-mono); fill: var(--text); }
.eai-rd { margin: 2px 0 0; font: 500 11.5px var(--f-body); color: var(--text-2); min-height: 16px; }
`;
  if (typeof document !== 'undefined' && !$('calcAiCss')) { const st = document.createElement('style'); st.id = 'calcAiCss'; st.textContent = CSS; document.head.appendChild(st); }

  /* =====================================================================
     1. Модель уровня: что доходит до модели и сколько ей нужно
     ===================================================================== */
  /* сколько раз больше придёт на модель, если упадёт соседняя того же класса за роутером с фолбэком (цель «пережить падение») */
  function failKOf(L, g, n) {
    const surv = (L.goals || []).some(x => x.t === 'survive' && (x.types === 'all' || (x.types || []).includes('llm')));
    if (!surv) return 1;
    const by = id => g.nodes.find(x => x.id === id);
    const par = g.edges.filter(e => e.to === n.id).map(e => by(e.from)).find(p => p && p.type === 'router' && p.props.failover);
    if (!par) return 1;
    const sib = g.edges.filter(e => e.from === par.id).map(e => by(e.to)).filter(x => x && x.type === 'llm' && x.props.size === n.props.size);
    return sib.length >= 2 ? sib.length / (sib.length - 1) : 1;
  }
  function llmOf(L, a, g, res, n, rag) {
    const r = res.nodes[n.id] || {}, ld = r.load || {}, info = r.info || {};
    const size = sizeOf(n), m = SD.LLM_SIZES[size], M = MEM[size], api = n.props.hosting === 'api', maxOut = n.props.maxOut || 512;
    const chat = (ld.chat || 0) + (ld.vchat || 0) + (ld.inject || 0), ag = ld.agentllm || 0, rps = chat + ag, agentic = ag > chat;
    const out = Math.min(maxOut, agentic ? a.agentOut : a.outTok);
    const inTok = a.inTok + (rag ? a.ragTok : 0), inCtx = agentic ? Math.round(inTok * 1.5) : inTok;
    const pc = !!n.props.pcache;
    const ttft = m.ttft * (pc ? 0.6 : 1) * (rag ? 1.3 : 1) + (api ? 60 : 0);
    const rw = info.rewriteMs || 0, gen = out / m.speed, resp = (ttft + rw) / 1000 + gen, conc = rps * resp;
    const ctxTok = inCtx + out, memGb = ctxTok * M.kv / 1000;
    const srvGpu = m.minGpu, srvGb = srvGpu * GPU_GB, freeGb = srvGb * SPARE - M.w;
    const seatsMem = freeGb > 0 ? Math.floor(freeGb / memGb) : 0;
    /* скорость: видеокарта печатает gpuTok токенов в секунду на всех; ответ — это печать плюс чтение входа (≈ 8 % от входа), как в симуляторе */
    const work = Math.min(maxOut, a.outTok) + inTok * 0.08, tokSrv = m.gpuTok * srvGpu, capFormula = tokSrv / work;
    let capSrv = capFormula;
    if (!api && r.cap > 0 && isFinite(r.cap) && (n.props.gpus || 0) > 0) capSrv = r.cap / n.props.gpus * srvGpu;
    const seatsSpeed = capSrv * resp, seats = Math.min(seatsMem, seatsSpeed);
    const failK = failKOf(L, g, n), load = rps * failK, loadConc = load * resp;
    const byMem = seatsMem > 0 ? Math.ceil(loadConc / (seatsMem * TARGET) - 1e-9) : Infinity;
    const bySpeed = Math.ceil(load / (capSrv * TARGET) - 1e-9);
    const servers = Math.max(1, byMem, bySpeed), gpusNeed = isFinite(servers) ? Math.min(32, servers * srvGpu) : 32;
    const tierNeed = load / TARGET, tierKey = ['basic', 'pro', 'ent'].find(k => SD.API_TIERS[k].rps >= tierNeed) || 'ent';
    const cacheF = pc ? 0.37 : 1, outChat = Math.min(maxOut, a.outTok);
    const usdApi = MONTH * (chat * (inTok * m.pIn * cacheF + outChat * m.pOut) + ag * (inTok * 1.5 * m.pIn * cacheF + a.agentOut * m.pOut)) / 1e6;
    const usdSelf = gpusNeed * SD.GPU_COST;
    return { n, name: nm(n), size, m, M, api, maxOut, chat, ag, rps, agentic, out, inTok, inCtx, pc, rag, ttft, rw, gen, resp, conc, ctxTok, memGb, srvGpu, srvGb, freeGb, seatsMem, work, tokSrv, capFormula, capSrv, seatsSpeed, seats, failK, load, loadConc, byMem, bySpeed, servers, gpusNeed, tierNeed, tierKey, usdApi, usdSelf, gpusNow: n.props.gpus || 0, tierNow: n.props.tier, stream: n.props.stream !== false, util: r.util || 0, simTtft: info.ttft || 0 };
  }
  function model(L) {
    const a = aiOf(L), g = SD.calc.refGraph(L), res = SD.sim.run(L, g, { mul: 1 });
    const rag = !!(res.ctx && res.ctx.ragActive);
    const llms = g.nodes.filter(n => n.type === 'llm' && ((res.nodes[n.id] || {}).rps || 0) > 0.001).map(n => llmOf(L, a, g, res, n, rag));
    if (!llms.length) return null;
    const main = llms.filter(x => !x.api).sort((p, q) => q.rps - p.rps)[0] || llms.slice().sort((p, q) => q.rps - p.rps)[0];
    const has = t => g.nodes.find(n => n.type === t && ((res.nodes[n.id] || {}).rps || 0) > 0.001);
    const tr = L.traffic || {}, asked = (tr.chat || 0) + (tr.voice || 0);
    const sc = has('semcache'), router = has('router'), agent = has('agent');
    const hit = sc ? a.repeat * (SEM[sc.props.threshold] || SEM['0.95']) : 0;
    const agentCalls = agent ? (((res.ctx && res.ctx.routeMemo && res.ctx.routeMemo.get(agent.id + '|chat')) || {}).calls || a.steps) : 0;
    const sumChat = llms.reduce((s, x) => s + x.chat, 0);
    const voice = (tr.voice || 0) > 0;
    const hitl = !!(agent && agent.props.hitl);
    const m = { L, a, g, res, rag, llms, main, asked, sc, router, agent, hit, agentCalls, sumChat, voice, hitl };
    m.mode = modeOf(m);
    m.plan = planOf(m);
    return m;
  }
  /* как отдавать ответ: правильный вариант и «тоже можно» */
  function modeOf(m) {
    const x = m.main, task = m.agent ? x.resp * m.agentCalls : x.resp;
    if (m.voice) return { right: 'stream', ok: [], task, why: 'Голос: каждое звено — потоком. Распознаём, пока человек говорит, модель отдаёт слова по мере печати, синтез звучит с первого предложения. Иначе паузы складываются.' };
    if (m.agent) return { right: 'queue', ok: ['stream'], task, why: `Задача агента — ${fx(m.agentCalls)} вызова модели и инструменты: ≈ ${sec(task)} и больше. ${m.hitl ? 'Возврат денег ещё и ждёт подтверждения оператора — это минуты. ' : ''}Такое ставят в очередь задач: «Приняли обращение, пришлём ответ», а ход работы можно показывать потоком («ищу заказ… проверяю условия…»).` };
    if (task <= 1.5) return { right: 'sync', ok: ['stream'], task, why: 'Ответ короче полутора секунд: можно отдать целиком. Поток не помешает, но и почти не нужен.' };
    if (task <= 20) return { right: 'stream', ok: [], task, why: 'Пустой экран дольше секунды раздражает, дольше 10 секунд — с него уходят. Поток (SSE) показывает первое слово почти сразу, а остальное человек читает, пока модель печатает.' };
    return { right: 'queue', ok: ['stream'], task, why: 'Ответ дольше 20 секунд: соединение может оборваться, а человек — уйти. Очередь задач с уведомлением: «Приняли, пришлём», готовый ответ — уведомлением или письмом.' };
  }
  /* расчёт → настройки моделей на эталоне */
  function planOf(m) { return m.llms.map(x => x.api ? [x.n.id, 'tier', x.tierKey] : [x.n.id, 'gpus', x.gpusNeed]); }

  /* =====================================================================
     2. Шаги: сначала угадай, потом формула
     ===================================================================== */
  function steps(m) {
    const x = m.main, out = [], A = x.agentic, what = A ? 'вызовов' : 'вопросов', mk = SD.LLM_SIZES[x.size];
    /* 1. сколько доходит до модели */
    {
      const lines = [`в пик — ${pn(m.asked, m.voice ? ['реплика', 'реплики', 'реплик'] : QW)} в секунду`];
      let v = m.asked;
      if (m.hit) { v *= 1 - m.hit; lines.push(`семантический кэш отвечает сам на ${pct(m.hit)}: ${num(m.asked)} × ${fx(1 - m.hit)} ≈ ${num(v)}`); }
      const share = m.router && m.sumChat ? x.chat / m.sumChat : 1;
      if (m.router && share < 0.999) { v *= share; lines.push(`роутер отправляет в «${x.name}» ≈ ${pct(share)}: ≈ ${num(v)}`); }
      if (A) { v *= m.agentCalls; lines.push(`агент на задачу вызывает модель ≈ ${fx(m.agentCalls)} раза: ≈ ${num(v)}`); }
      lines.push(`<b>≈ ${num(x.rps)}/с</b> доходит до модели «${esc(x.name)}» — столько и показывает симулятор на эталоне${num(v) !== num(x.rps) ? ' (плюс прорвавшиеся атаки и мелочи маршрута)' : ''}.`);
      const parts = [];
      if (m.sc) parts.push(`Семантический кэш отвечает сам на ≈ ${pct(m.hit)} вопросов (повторов ${pct(m.a.repeat)} × попаданий ${pct(SEM[m.sc.props.threshold] || SEM['0.95'])}).`);
      if (m.router && share < 0.999) parts.push(`Роутер отправляет в «${x.name}» ≈ ${pct(share)} того, что дошло до моделей.`);
      if (A) parts.push(`Агент на каждую задачу вызывает модель ≈ ${fx(m.agentCalls)} раза.`);
      out.push({ id: 'rps', title: 'Сколько доходит до модели', unit: A ? 'вызовов/с' : 'вопросов/с',
        an: A ? 'Сложный заказ повар готовит в несколько заходов: каждый заход — отдельная работа у плиты.' : 'Не каждый посетитель доходит до повара: на частые вопросы отвечает администратор по памятке, хулиганов не пускает охрана.',
        q: `В пик приходит ${m.voice ? pn(m.asked, ['голосовая реплика', 'голосовые реплики', 'голосовых реплик']) : pn(m.asked, QW)} в секунду. ${parts.join(' ')} Сколько ${what} в секунду доходит до модели «${x.name}»?`,
        ans: x.rps, how: lines,
        so: 'Каждый вопрос, который не дошёл до модели, — это секунды видеокарты и деньги за токены, которые не потрачены.' });
    }
    /* 2. длина ответа */
    {
      const words = Math.max(10, Math.round(x.out / WPT / 10) * 10);
      out.push({ id: 'tok', title: A ? 'Длина одного шага в токенах' : 'Длина ответа в токенах', unit: 'токенов',
        an: 'Модель пишет не словами, а кусочками слов — токенами. По токенам считают и время, и деньги.',
        q: A ? `На каждом шаге агент пишет короткое решение — какой инструмент вызвать и с чем, ≈ ${words} слов. В русском тексте ≈ 1,5 токена на слово. Сколько токенов в одном шаге?`
          : `Ответ ${m.voice ? 'голосом — короткий' : 'ассистента'}: ≈ ${words} слов. В русском тексте ≈ 1,5 токена на слово. Сколько токенов в ответе?`,
        ans: x.out,
        how: [`${words} × 1,5 ≈ <b>${num(x.out)} токенов</b>`,
          x.out >= x.maxOut ? `Лимит ответа у модели — ${num(x.maxOut)} токенов: длиннее она не напишет, ответ обрежется.` : `Лимит ответа у модели — ${num(x.maxOut)} токенов: хватает.`,
          `Вход тоже в токенах: вопрос и инструкции ≈ ${num(m.a.inTok)}${x.rag ? ` + куски документов из поиска ≈ ${num(m.a.ragTok)}` : ''}${A ? ' (у агента контекст растёт от шага к шагу, ×1,5)' : ''}${x.rag || A ? ` = ${num(x.inCtx)}` : ''}. От входа зависят пауза до первого слова, память и цена.`],
        so: 'На салфетке: страница текста ≈ 500 слов ≈ 750 токенов. Английский плотнее — ≈ 1,3 токена на слово; точнее покажет токенизатор модели.' });
    }
    /* 3. печать */
    out.push({ id: 'gen', title: A ? 'Сколько модель печатает шаг' : 'Сколько модель печатает ответ', unit: 'с',
      an: 'Модель печатает, как человек на клавиатуре: слово за словом. Длинный ответ печатается долго, сколько серверов ни ставь.',
      q: `Модель «${mk.name}» печатает ≈ ${mk.speed} токенов в секунду каждому разговору. Сколько секунд уходит на ${num(x.out)} токенов?`,
      ans: x.gen,
      how: [`${num(x.out)} ÷ ${mk.speed} = <b>${sec(x.gen)}</b>`, 'Скорость печати одному разговору почти не зависит от числа серверов: больше серверов — больше разговоров сразу, но каждый печатается так же.', 'Малая модель печатает ≈ 160 токенов/с, средняя ≈ 80, большая ≈ 45.'],
      so: 'Поэтому для модели не работает привычное «запрос — миллисекунды»: даже на свободном сервере ответ идёт секунды.' });
    /* 4. полное время */
    {
      const bits = [`≈ ${F().ms(mk.ttft)} у этой модели`];
      if (x.pc) bits.push('кэш промпта ×0,6');
      if (x.rag) bits.push('длинный контекст с документами ×1,3');
      if (x.api) bits.push('+ ≈ 60 мс сети до поставщика');
      out.push({ id: 'resp', title: A ? 'Сколько длится один вызов' : 'Полное время ответа', unit: 'с',
        an: 'Сначала продавец выслушивает вопрос и сверяется с каталогом — пауза. Потом говорит.',
        q: `До первого слова модель читает весь вход — это TTFT: ${bits.join(', ')} — итого ≈ ${F().ms(x.ttft)}.${x.rw ? ` Переписывание вопроса перед поиском добавляет ≈ ${F().ms(x.rw)}.` : ''} Сколько секунд ${A ? 'длится один вызов модели' : 'от вопроса до последнего слова'}?`,
        ans: x.resp,
        how: [`${fx(x.ttft / 1000)}${x.rw ? ` + ${fx(x.rw / 1000)}` : ''} + ${fx(x.gen)} = <b>${sec(x.resp)}</b>`,
          `Первое слово готово через ${sec((x.ttft + x.rw) / 1000)} — его человек увидит, если ответ идёт потоком.`,
          A ? `Вся задача агента — ${fx(m.agentCalls)} вызова подряд: ≈ ${sec(x.resp * m.agentCalls)} только на модель, плюс инструменты.` : '',
          'Под нагрузкой пауза растёт: вопросы ждут свободного места. В симуляторе при загрузке 75 % — примерно ×2,7.'] });
    }
    /* 5. Литтл */
    out.push({ id: 'conc', title: 'Сколько разговоров идёт одновременно', unit: 'разговоров',
      an: 'Кафе: за час приходит 60 гостей, каждый сидит полчаса — значит, одновременно занято ≈ 30 столиков. Столиков нужно по числу сидящих, а не по числу входящих.',
      q: `До модели доходит ${pn(x.rps, A ? CW : QW)} в секунду, каждый занимает её ≈ ${sec(x.resp)}. Сколько разговоров модель ведёт одновременно?`,
      ans: x.conc,
      how: ['Закон Литтла: одновременно = поток × время.', `${num(x.rps)} × ${fx(x.resp)} ≈ <b>${fx(x.conc)}</b>`,
        `Сравни: обычный сервис на ${pn(x.rps, ZW)} в секунду с ответом 50 мс держит одновременно ${fx(x.rps * 0.05)} — в ${pn(x.resp / 0.05, ['раз', 'раза', 'раз'])} меньше.`,
        x.failK > 1 ? `Цель уровня — пережить падение модели: если упадёт соседняя того же класса, её вопросы придут сюда (×${fx(x.failK)}) → ≈ ${pn(x.loadConc, DW, fx)}. Дальше считаем с этим запасом.` : ''],
      so: 'Именно одновременные разговоры, а не запросы в секунду, упираются в модель: каждому нужно место в видеопамяти и доля скорости видеокарты.' });
    if (!x.api) {
      /* 6. память на разговор */
      out.push({ id: 'mem', title: 'Память на один разговор', unit: 'ГБ',
        an: 'У каждого гостя свой столик с бумагами: пока разговор идёт, модель держит его черновик — всё прочитанное и написанное — в быстрой памяти видеокарты.',
        q: `Черновик разговора (KV-кэш) — это весь контекст: вход ${num(x.inCtx)} + ответ ${num(x.out)} = ${num(x.ctxTok)} токенов. У модели класса «${sizeShort[x.size]}» (${x.M.what}) токен черновика занимает ≈ ${comma(x.M.kv)} МБ. Сколько гигабайт на один разговор?`,
        ans: x.memGb,
        how: [`${num(x.ctxTok)} × ${comma(x.M.kv)} МБ ≈ ${num(x.ctxTok * x.M.kv)} МБ ≈ <b>${gbf(x.memGb)} ГБ</b>`, 'Размер на токен зависит от модели: слои × «головы» ключей × их размер × 2 (ключи и значения) × байты на число. У 70B ≈ 0,3 МБ, у 8B ≈ 0,13 МБ.', 'Длинный контекст дорог: агент с историей на 30 000 токенов держит у средней модели ≈ 10 ГБ на разговор.'] });
      /* 7. мест на сервере */
      const lim = x.seatsSpeed < x.seatsMem ? 'speed' : 'mem';
      out.push({ id: 'seats', title: 'Сколько разговоров помещается на сервер', unit: 'разговоров',
        an: 'Плита: веса модели — огромная кастрюля, которая стоит всегда; на остальные конфорки ставят черновики разговоров.',
        q: `Сервер модели — ${x.srvGpu} ${plural(x.srvGpu, GPUW)} по 80 ГБ = ${x.srvGb} ГБ. Сама модель (${x.M.what}) занимает ≈ ${x.M.w} ГБ, служебное — ≈ 10 %. Сколько разговоров по ${gbf(x.memGb)} ГБ поместится в память?`,
        ans: x.seatsMem,
        how: [`${x.srvGb} × 0,9 − ${x.M.w} = ${num(x.freeGb)} ГБ под черновики`, `${num(x.freeGb)} ÷ ${gbf(x.memGb)} ≈ <b>${num(x.seatsMem)}</b> ${plS(num(x.seatsMem), DW)} по памяти`,
          `Но сервер печатает не бесконечно быстро: ≈ ${num(x.tokSrv)} токенов/с на всех. Ответ — это ${num(Math.min(x.maxOut, m.a.outTok))} токенов печати плюс чтение входа (по нагрузке ≈ 8 % от ${num(x.inTok)}) ≈ ${pn(x.work, TW)} работы. Сервер тянет ≈ ${pn(x.capSrv, QW, fx)} в секунду${Math.abs(x.capSrv - x.capFormula) > 0.03 * x.capFormula ? ` (по формуле ${fx(x.capFormula)}; симулятор учитывает ещё переписывание вопроса)` : ''} — это ≈ ${pn(x.seatsSpeed, DW, fx)} одновременно по скорости.`,
          `Мест на сервер — меньшее из двух: <b>${fx(x.seats)}</b> — ${lim === 'speed' ? 'упирается в скорость' : 'упирается в память'}.`],
        so: lim === 'speed' ? 'Здесь места кончаются по скорости: по памяти разговоров влезло бы больше, но каждый печатался бы медленнее (об этом — вкладка «Пачка» в лаборатории). С длинным контекстом — агенты, большие документы — раньше кончается память.' : 'Здесь места кончаются по памяти: контекст длинный. Помогают короче контекст, сжатый черновик (FP8) или модель с меньшим размером на токен.' });
      /* 8. сколько серверов */
      out.push({ id: 'servers', title: 'Сколько серверов модели', unit: 'серверов',
        an: 'Сколько касс открыть: число покупателей у касс делим на то, сколько ведёт одна касса, и оставляем запас, чтобы новые не ждали у входа.',
        q: `Одновременно идёт ${pn(x.loadConc, DW, fx)}${x.failK > 1 ? ' (с запасом на падение соседней модели)' : ''}, на сервере ${pn(x.seats, PW, fx)}. Держим загрузку не выше 75 %. Сколько серверов по ${x.srvGpu} ${plural(x.srvGpu, GPUW)} нужно?`,
        ans: x.servers,
        how: [`${fx(x.loadConc)} ÷ (${fx(x.seats)} × 0,75) = ${fx(x.loadConc / (x.seats * TARGET))} → <b>${x.servers}</b>`,
          `То есть ${x.gpusNeed} ${plural(x.gpusNeed, GPUW)} × $${num(SD.GPU_COST)} = ${usd(x.usdSelf)} в месяц.`,
          `На эталоне уровня — ${x.gpusNow} ${plural(x.gpusNow, GPUW)}${x.gpusNow === x.gpusNeed ? ': расчёт совпал' : x.gpusNow > x.gpusNeed ? ': там взяли с запасом' : ''}.`],
        so: 'Почему 75 %: у края ёмкости вопросы ждут свободного места, и пауза до первого слова растёт в разы. Это и есть «реплики модели»: одинаковые серверы с одной моделью за балансировщиком.' });
    } else {
      const T = SD.API_TIERS, tn = k => T[k].name.split(' — ')[0];
      out.push({ id: 'limit', title: 'Какой лимит нужен у поставщика', unit: 'запросов/с',
        an: 'Модель чужая — как кухня ресторана, у которого заказываешь доставку: готовит сколько угодно, но по договору принимает не больше N заказов в минуту.',
        q: `Поставщик берёт деньги за токены и ограничивает поток: ${Object.keys(T).map(k => `${tn(k)} — ${T[k].rps}/с`).join(', ')}. До модели доходит ${pn(x.load, A ? CW : QW)} в секунду${x.failK > 1 ? ' с запасом на падение соседней модели' : ''}. Держим запас 25 %. Какой лимит нужен?`,
        ans: x.tierNeed,
        how: [`${num(x.load)} ÷ 0,75 ≈ <b>${pn(x.tierNeed, ZW)} в секунду</b> → тариф «${tn(x.tierKey)}» (${T[x.tierKey].rps}/с)${x.tierNeed > T.ent.rps ? ' — и его мало: нужен договор выше или второй поставщик' : ''}.`,
          'Сверх лимита поставщик отвечает 429 — запрос повторяют позже или отправляют другому поставщику (фолбэк в роутере).',
          `Одновременно у поставщика висит ≈ ${fx(x.conc)} наших запросов. У некоторых поставщиков лимит и на это (одновременные запросы, токены в минуту) — тогда считают как у своих серверов.`],
        so: 'Свои видеокарты не нужны, но и места у поставщика не бесконечные: лимит — та же ёмкость, только чужая и по договору.' });
    }
    /* 9. как отдавать */
    {
      const md = m.mode, first = (x.ttft + x.rw) / 1000;
      out.push({ id: 'mode', title: 'Как отдавать ответ', pick: [['sync', 'Синхронно: ждать весь ответ'], ['stream', 'Потоком (SSE): слова по мере печати'], ['queue', 'Очередь задач и уведомление']],
        right: md.right, okAlt: md.ok,
        an: 'Медленный рассказчик: можно молча ждать, пока он договорит; можно слушать, пока говорит; а можно взять талончик «перезвоним».',
        q: `${A ? `Задача агента — ≈ ${sec(md.task)}` : `Весь ответ — ≈ ${sec(x.resp)}`}, первое слово готово через ${sec(first)}. Человек замечает паузу больше секунды и бросает пустой экран после ≈ 10 с. Как отдавать ответ?`,
        how: [`Синхронно: ${sec(md.task)} пустого экрана с крутилкой${md.task > 10 ? ' — многие уйдут, а шлюз может оборвать соединение по таймауту' : ''}.`,
          `Потоком (SSE): первое слово через ${sec(first)}, дальше текст печатается на глазах. Соединение держится ${sec(md.task)}, открытых соединений у сервиса одновременно ≈ ${fx(x.conc)}.`,
          'Очередь: «Приняли, пришлём» за десятые доли секунды, готовый ответ — уведомлением. Нужна для долгого (многошаговый агент, разбор документа, отчёт) и ещё сглаживает пик: серверы можно держать под среднюю нагрузку.'],
        so: md.why });
    }
    /* 10. цена */
    {
      const pIn = x.m.pIn, pOut = x.m.pOut, outC = Math.min(x.maxOut, m.a.outTok), pcs = x.pc ? ' (кэш промпта: вход ×0,37)' : '';
      const per = (x.chat * (x.inTok * pIn * (x.pc ? 0.37 : 1) + outC * pOut) + x.ag * (x.inTok * 1.5 * pIn * (x.pc ? 0.37 : 1) + m.a.agentOut * pOut)) / Math.max(1e-9, x.rps) / 1e6;
      const ratio = x.usdApi / Math.max(1, x.usdSelf);
      out.push({ id: 'cost', title: x.api ? 'Цена токенов в месяц' : 'А сколько стоило бы через API', unit: '$ в месяц',
        an: 'Свою кофемашину оплачиваешь, даже когда она стоит; в кофейне платишь за каждую чашку. Что выгоднее — решает, сколько чашек в день.',
        q: `${num(x.rps)}/с × 2,63 млн секунд в месяц. На ${A ? 'вызов' : 'вопрос'} ≈ ${num(A ? x.inTok * 1.5 : x.inTok)} входных токенов по $${comma(pIn)} за миллион${pcs} и ${num(A ? m.a.agentOut : outC)} выходных по $${comma(pOut)}. Сколько долларов в месяц${x.api ? '' : ', если отдать модель поставщику'}?`,
        ans: x.usdApi,
        how: [`один ${A ? 'вызов' : 'ответ'} ≈ $${comma(per.toFixed(4))}`, `${num(x.rps)} × 2,63 млн × $${comma(per.toFixed(4))} ≈ <b>${usd(x.usdApi)}</b> в месяц`,
          x.api ? `Те же ${A ? 'вызовы' : 'вопросы'} на своих видеокартах: ${x.servers} ${plural(x.servers, SRV)} × ${x.srvGpu} × $${num(SD.GPU_COST)} = ${usd(x.usdSelf)}${x.usdSelf < x.usdApi ? ' — дешевле, но платишь и в простое, и нужна команда' : ' — дороже: при такой нагрузке видеокарты простаивают'}.`
            : `Свои видеокарты: ${x.gpusNeed} × $${num(SD.GPU_COST)} = ${usd(x.usdSelf)} — ${ratio >= 1.2 ? `в ${fx(ratio)} раза дешевле` : ratio <= 0.83 ? `в ${fx(1 / ratio)} раза дороже` : 'примерно столько же'}.`],
        so: 'При ровной большой нагрузке свои видеокарты дешевле, при малой или скачущей — API: платишь только за токены. Бюджет токенов срезают лимит длины ответа, короткий контекст, кэш промпта, семантический кэш и малая модель для простых вопросов.' });
    }
    return out;
  }

  /* =====================================================================
     3. Окно расчёта
     ===================================================================== */
  const KEY = 'amp-stroyka-calcai-v1';
  let U = {};
  try { U = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { U = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(U)); } catch (e) { /* без хранилища */ } };
  function parse(s) {
    s = String(s || '').trim().toLowerCase().replace(/[\s $]/g, '').replace(',', '.');
    const r = s.match(/^([0-9.]+)(к|k|тыс|млн|m|млрд|b)?/); if (!r) return NaN;
    return parseFloat(r[1]) * ({ 'к': 1e3, k: 1e3, 'тыс': 1e3, 'млн': 1e6, m: 1e6, 'млрд': 1e9, b: 1e9 }[r[2]] || 1);
  }
  function grade(g, a) {
    if (!(g > 0) || !(a > 0)) return 'miss';
    const d = Math.abs(Math.log10(g / a));
    return d <= 0.1 ? 'exact' : d <= 0.48 ? 'order' : 'miss';
  }
  const GL = { exact: '✓ точно', order: '≈ порядок верный', miss: '✗ мимо', shown: 'ответ открыт', right: '✓ верно', part: '≈ можно и так', wrong: '✗ не то' };
  const CLS = { right: 'exact', part: 'order', wrong: 'miss' };
  const fmtAns = v => v >= 100 ? num(v) : fx(v);
  let M = null, S = [], CARD_CLOSED = false;
  const HINT = new Set();
  const st = id => ((U[M.L.id] || {})[id]);
  const aiLevels = () => (SD.LEVELS || []).filter(l => SD.calc.usableAi(l));
  function open(L) {
    let m0 = null;
    try { m0 = model(L); } catch (e) { m0 = null; if (window.console) console.warn('ИИ-расчёт: ', e); }
    if (!m0) { SD.app.toast('Здесь модель ничего не получает — считать нечего.'); return; }
    M = m0; S = steps(M); HINT.clear();
    /* «На пальцах» раскрыта, пока человек ничего не считал; свёрнутость решаем один раз при открытии, а не на каждой перерисовке */
    CARD_CLOSED = !!Object.keys(U).length;
    let w = $('calcAiModal');
    if (!w) {
      w = document.createElement('div'); w.className = 'modal'; w.id = 'calcAiModal'; w.hidden = true;
      w.innerHTML = '<div class="sheet calc-sheet" role="dialog" aria-modal="true" aria-labelledby="calcAiTitle"><div class="sheet-head"><span class="eyebrow" style="margin:0">Как посчитать · ИИ</span><h2 id="calcAiTitle"></h2><button class="btn ghost x" type="button" data-caix>Закрыть</button></div><div class="calc-wrap"><div class="calc-steps" id="calcAiSteps"></div><aside class="calc-side" id="calcAiSide"></aside></div></div>';
      document.body.appendChild(w);
      w.addEventListener('click', onClick);
      w.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-caiin]')) { e.preventDefault(); check(e.target.dataset.caiin); } });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !w.hidden) w.hidden = true; });
    }
    $('calcAiTitle').textContent = 'Расчёт на салфетке: ' + M.L.title;
    render(); w.hidden = false;
    const sc = $('calcAiSteps'); if (sc) sc.scrollTop = 0;
  }
  function render() {
    const done = S.filter(s => st(s.id)).length, cur = SD.app && SD.app.A && SD.app.A.level;
    const lv = aiLevels();
    let h = '';
    if (SD.fingers && SD.fingers.card) h += SD.fingers.card({ id: 'calc-ai', title: 'Как посчитать модель', fingers: FG }, { closed: CARD_CLOSED });
    if (lv.length > 1) h += `<div class="cai-lv" role="group" aria-label="Уровень для расчёта"><span>Уровень:</span>${lv.map(l => `<button type="button" data-cailv="${esc(l.id)}" aria-pressed="${l.id === M.L.id}">${esc(l.title)}${cur && cur.id === l.id ? ' · открыт' : ''}</button>`).join('')}</div>`;
    h += `<p class="calc-lede">У модели ответ идёт секунды, поэтому считаем по-другому: не «сколько запросов в секунду», а «сколько разговоров сразу» и хватит ли им мест на сервере модели. Впиши оценку и нажми «Проверить» (Enter): «точно» — в пределах ±25 %, «порядок верный» — в пределах ×3. Можно писать «15к», «2,5 млн». Считаем модель «${esc(M.main.name)}»${M.llms.length > 1 ? `, остальные модели схемы — в итоге справа` : ''}. Пройдено: ${done} из ${S.length}.</p>`;
    h += S.map((s, i) => {
      const g = st(s.id), open = !!g, gcls = CLS[g] || g || '';
      const input = s.pick
        ? `<div class="cai-pick" role="group" aria-label="${esc(s.title)}">${s.pick.map(([k, t]) => `<button type="button" class="btn" data-caipick="${s.id}" data-v="${k}" aria-pressed="${!!g && (U[M.L.id] || {})[s.id + ':v'] === k}">${esc(t)}</button>`).join('')}<button type="button" class="linkish" data-caishow="${s.id}">Показать ответ</button></div>`
        : `<div class="cs-in"><input type="text" inputmode="decimal" autocomplete="off" data-caiin="${s.id}" placeholder="твоя оценка" aria-label="${esc(s.title)}: твоя оценка"><span>${esc(s.unit)}</span><button type="button" class="btn" data-caick="${s.id}">Проверить</button><button type="button" class="linkish" data-caihint="${s.id}">${HINT.has(s.id) ? 'Скрыть подсказку' : 'Подсказка: как считать'}</button><button type="button" class="linkish" data-caishow="${s.id}">Показать ответ</button></div>`;
      const ans = s.pick ? `Ответ: ${esc((s.pick.find(p => p[0] === s.right) || [])[1] || '')}` : `Ответ: ${fmtAns(s.ans)} ${esc(s.unit)}`;
      return `<section class="calc-step ${gcls}" data-step="${s.id}"><div class="cs-h"><span class="cs-n">${i + 1}</span><b>${esc(s.title)}</b>${g ? `<span class="cs-st">${GL[g]}</span>` : ''}</div>
        <p class="cs-an">${esc(s.an)}</p><p class="cs-q">${esc(s.q)}</p>${input}
        ${HINT.has(s.id) && !open && !s.pick ? `<div class="cs-hint"><b>Как считать:</b><ul>${s.how.filter(Boolean).map(x => `<li>${x.replace(/<b>[^<]*<\/b>/g, '<b>?</b>').replace(/(=|≈) ?\$?(\d[\d   ,.]*)/g, '$1 ?')}</li>`).join('')}</ul><p>Посчитай то, что под «?», и впиши ответ.</p></div>` : ''}
        <div class="cs-ans" ${open ? '' : 'hidden'}><b class="cs-a">${ans}</b><ul>${s.how.filter(Boolean).map(x => `<li>${x}</li>`).join('')}</ul>${s.so ? `<p class="cs-so">${esc(s.so)}</p>` : ''}</div></section>`;
    }).join('');
    $('calcAiSteps').innerHTML = h;
    side();
  }
  function side() {
    const m = M, x = m.main, rows = [];
    let gpuUsd = 0, tokUsd = 0;
    m.llms.forEach(y => {
      if (y.api) { rows.push([y.name, `API, тариф «${SD.API_TIERS[y.tierKey].name.split(' — ')[0]}»`, `${num(y.rps)}/с, сразу ≈ ${fx(y.conc)} разг.`, y.usdApi]); tokUsd += y.usdApi; }
      else { rows.push([y.name, `свои: ${y.servers} ${plural(y.servers, SRV)} × ${y.srvGpu} GPU`, `${num(y.rps)}/с, сразу ≈ ${fx(y.conc)} разг.`, y.usdSelf]); gpuUsd += y.usdSelf; }
    });
    const first = (x.ttft + x.rw) / 1000, md = m.mode, ml = { sync: 'синхронно', stream: 'потоком (SSE)', queue: 'через очередь' }[md.right];
    let h = `<h3>Итог для моделей</h3><table class="calc-sum">${rows.map(([a, b, c, d]) => `<tr><td>${esc(a)}</td><td>${esc(b)}<small>${esc(c)}</small></td><td>${esc(usd(d))}</td></tr>`).join('')}<tr class="tot"><td>Модели в месяц</td><td></td><td>${usd(gpuUsd + tokUsd)}</td></tr></table>`;
    const total = x.resp * (m.agent ? m.agentCalls : 1);
    h += `<div class="cai-see"><b>Что видит человек — ${ml}</b><div class="cai-bar" aria-hidden="true"><i class="wait" style="width:100%"></i><i style="width:${Math.max(3, Math.min(100, first / Math.max(total, 0.01) * 100)).toFixed(1)}%"></i></div><div class="cai-row"><span>первое слово ${sec(first)}</span><span>${m.agent ? 'задача' : 'весь ответ'} ${sec(total)}</span></div><span>${md.right === 'stream' ? `Поток: текст бежит со скоростью ≈ ${x.m.speed} токенов/с — быстрее, чем человек читает.` : md.right === 'queue' ? 'Очередь: сразу «Приняли, пришлём», ответ — уведомлением.' : 'Ответ целиком почти сразу.'}</span></div>`;
    {
      const perAns = (gpuUsd + tokUsd) * RUB / Math.max(1, m.asked * MONTH);
      const fr = v => v >= 1e6 ? comma((v / 1e6).toFixed(1)) + ' млн ₽' : v >= 1000 ? Math.round(v / 1000).toLocaleString('ru-RU') + ' тыс. ₽' : v >= 1 ? comma(v.toFixed(v < 10 ? 1 : 0)) + ' ₽' : comma(v.toFixed(2)) + ' ₽';
      h += `<details class="calc-biz"><summary>Для бизнеса</summary><ul>
        <li>Модели в месяц: <b>${fr((gpuUsd + tokUsd) * RUB)}</b> при ${num(m.asked * MONTH / 1e6)} млн ${m.voice ? 'реплик' : 'вопросов'}.</li>
        <li>Один ответ: <b>${fr(perAns)}</b>; тысяча ответов — <b>${fr(perAns * 1000)}</b>.</li>
        <li>${x.api ? `На своих видеокартах «${esc(x.name)}» стоила бы ${usd(x.usdSelf)} вместо ${usd(x.usdApi)} за токены.` : `Через API «${esc(x.name)}» стоила бы ${usd(x.usdApi)} вместо ${usd(x.usdSelf)} за видеокарты.`} Свои дешевле при ровной большой нагрузке, но платишь и в простое, и нужна команда.</li>
        <li>Каждая лишняя секунда ожидания без потока — часть людей закрывает чат и пишет в поддержку.</li>
      </ul><small>Допущения: $1 = ${RUB} ₽; нагрузка уровня — средняя за месяц (как в симуляторе), 2,63 млн секунд в месяце; видеокарта ≈ $${num(SD.GPU_COST)} в месяц; цены за токены — ориентиры классов моделей.</small></details>`;
    }
    const isCur = SD.app && SD.app.A && SD.app.A.level && SD.app.A.level.id === m.L.id;
    h += `<div class="calc-act"><button type="button" class="btn primary" data-caisim>Проверить расчёт на симуляторе</button>${isCur ? '<button type="button" class="btn" data-caiapply>Поставить эти числа на мою схему</button>' : ''}<button type="button" class="btn" data-cailab>Покрутить ползунками — «Оценка на салфетке: ИИ»</button></div><div id="calcAiRes"></div>`;
    h += `<p class="calc-note">Сколько доходит до модели и сколько тянет видеокарта по скорости — из симулятора на эталоне уровня. Память на разговор симулятор не моделирует: её считаем по формуле, и тут расчёт строже симулятора. Серверов = разговоров ÷ (мест × 0,75).</p>`;
    $('calcAiSide').innerHTML = h;
  }
  function check(id) {
    const s = S.find(z => z.id === id), inp = document.querySelector(`[data-caiin="${id}"]`); if (!s || !inp) return;
    const g = grade(parse(inp.value), s.ans);
    U[M.L.id] = Object.assign({}, U[M.L.id], { [id]: g }); save();
    const val = inp.value; render();
    const ni = document.querySelector(`[data-caiin="${id}"]`); if (ni) ni.value = val;
    const next = S[S.findIndex(z => z.id === id) + 1]; if (next) { const n2 = document.querySelector(`[data-caiin="${next.id}"]`); if (n2) n2.focus({ preventScroll: true }); }
  }
  function pick(id, v) {
    const s = S.find(z => z.id === id); if (!s) return;
    const g = v === s.right ? 'right' : (s.okAlt || []).includes(v) ? 'part' : 'wrong';
    U[M.L.id] = Object.assign({}, U[M.L.id], { [id]: g, [id + ':v']: v }); save(); render();
  }
  /* эталон уровня с числами из расчёта → симулятор и цели уровня */
  function simCheck() {
    const L = M.L, g = SD.calc.refGraph(L);
    M.plan.forEach(([id, k, v]) => { const n = g.nodes.find(z => z.id === id); if (n) n.props[k] = v; });
    const res = SD.sim.run(L, g, { mul: 1 }), goals = SD.evalGoals(L, g, res, SD.sim.chaos(L, g), SD.sim.analyze(L, g, res));
    const ok = goals.filter(z => z.ok).length;
    const rowsL = M.llms.map(y => {
      const r = res.nodes[y.n.id] || {}, i = r.info || {}, t = ((i.ttft || 0) + (i.rewriteMs || 0)) / 1000, full = t + (y.agentic ? y.gen : (i.gen || 0) / 1000);
      return `<tr><td>${esc(y.name)}</td><td>загрузка ${pct(r.util || 0)} · первое слово ${sec(t)} · весь ответ ${sec(full)}</td></tr>`;
    }).join('');
    $('calcAiRes').innerHTML = `<div class="calc-res ${ok === goals.length ? 'ok' : ''}"><b>Эталон уровня с числами из расчёта:</b><span>успешно ${F().pct(res.total.success)} · ${F().ms(res.total.lat)} · ${usd(res.cost)}/мес</span><table class="cai-res-t">${rowsL}</table><ul>${goals.map(z => `<li class="${z.ok ? 'ok' : 'bad'}">${z.ok ? '✓' : '✗'} ${esc(z.text)} <small>${esc(z.detail)}</small></li>`).join('')}</ul><p>${ok === goals.length ? 'Расчёт на салфетке выдерживает все цели. Загрузка модели — около 75 % или ниже: так и задумано.' : 'Где не хватило — смотри красное: обычно добирают запас или меняют устройство схемы (кэш, роутер, поток).'} Под нагрузкой симулятор добавляет к паузе до первого слова ожидание свободного места — поэтому она больше, чем в шаге 4.</p></div>`;
  }
  function apply() {
    const A = SD.app.A, ch = [];
    M.plan.forEach(([id, k, v]) => {
      const ref = M.g.nodes.find(z => z.id === id);
      const same = A.graph.nodes.find(z => z.id === id && z.type === 'llm');
      const ofType = A.graph.nodes.filter(z => z.type === 'llm'), refOf = M.g.nodes.filter(z => z.type === 'llm');
      const n = same || (ofType.length === 1 && refOf.length === 1 ? ofType[0] : null);
      if (!n || !ref) return;
      /* у своей модели свой хостинг: на API ставим тариф, на своих видеокартах — число видеокарт */
      const y = M.llms.find(z => z.n.id === id);
      const key = n.props.hosting === 'api' ? 'tier' : 'gpus', val = key === k ? v : key === 'tier' ? y.tierKey : y.gpusNeed;
      if (n.props[key] !== val) ch.push([n, key, val]);
    });
    if (!ch.length) { SD.app.toast('На твоей схеме нечего менять: моделей нет или числа уже такие.'); return; }
    ch.forEach(([n, k, v]) => SD.app.setProp(n.id, k, v));
    $('calcAiModal').hidden = true;
    SD.app.toast(`Расчёт поставлен на схему: ${ch.map(([n, k, v]) => `«${nm(n)}» ${k === 'gpus' ? v + ' GPU' : 'тариф ' + SD.API_TIERS[v].name.split(' — ')[0]}`).join(', ')}.`);
  }
  /* лаборатория с числами этого уровня */
  function toLab() {
    const x = M.main;
    $('calcAiModal').hidden = true;
    const p = { model: x.size, rps: +x.rps.toFixed(2), out: x.out, speed: x.m.speed, ttft: +(((x.ttft + x.rw) / 1000).toFixed(2)), ctx: x.ctxTok, vram: x.srvGb, mode: M.mode.right, from: M.L.title, tab: 'calc', batch: 0 };
    PENDING = p;
    SD.labs.open('estai').then(() => { if (LAB && PENDING) { LAB.set(PENDING); PENDING = null; } });
  }
  function onClick(e) {
    const w = $('calcAiModal');
    if (e.target === w || e.target.closest('[data-caix]')) { w.hidden = true; return; }
    const lvb = e.target.closest('[data-cailv]'); if (lvb) { const L = SD.levelById(lvb.dataset.cailv); if (L && L.id !== M.L.id) open(L); return; }
    const c = e.target.closest('[data-caick]'); if (c) { check(c.dataset.caick); return; }
    const pb = e.target.closest('[data-caipick]'); if (pb) { pick(pb.dataset.caipick, pb.dataset.v); return; }
    const hb = e.target.closest('[data-caihint]'); if (hb) { const id = hb.dataset.caihint, val = (document.querySelector(`[data-caiin="${id}"]`) || {}).value; if (HINT.has(id)) HINT.delete(id); else HINT.add(id); render(); const ni = document.querySelector(`[data-caiin="${id}"]`); if (ni && val) ni.value = val; return; }
    const sb = e.target.closest('[data-caishow]'); if (sb) { const id = sb.dataset.caishow; if (!st(id)) { U[M.L.id] = Object.assign({}, U[M.L.id], { [id]: 'shown' }); save(); } render(); return; }
    if (e.target.closest('[data-caisim]')) { simCheck(); return; }
    if (e.target.closest('[data-caiapply]')) { apply(); return; }
    if (e.target.closest('[data-cailab]')) { toLab(); }
  }

  /* =====================================================================
     4. Лаборатория «Оценка на салфетке: ИИ»: та же арифметика ползунками
     ===================================================================== */
  let LAB = null, PENDING = null, LASTP = null;
  const PRESET = k => { const m = SD.LLM_SIZES[k]; return { model: k, speed: m.speed, ttft: m.ttft / 1000, vram: m.minGpu * GPU_GB }; };
  const DEF = () => Object.assign({ rps: 3, out: 300, ctx: 3600, mode: 'stream', batch: 0, tab: 'calc', from: '' }, PRESET('medium'));
  /* логарифмические ползунки: позиция 0…1000 ↔ значение */
  const LOG = { rps: [0.1, 1000], out: [50, 4000], ctx: [1000, 128000], batch: [1, 256] };
  const toPos = (k, v) => Math.round(Math.log(v / LOG[k][0]) / Math.log(LOG[k][1] / LOG[k][0]) * 1000);
  const fromPos = (k, p) => LOG[k][0] * Math.pow(LOG[k][1] / LOG[k][0], p / 1000);
  const niceV = (k, v) => k === 'rps' ? (v >= 100 ? Math.round(v / 10) * 10 : v >= 10 ? Math.round(v) : v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100) : k === 'out' ? (v >= 1000 ? Math.round(v / 100) * 100 : Math.round(v / 10) * 10) : k === 'ctx' ? (v >= 10000 ? Math.round(v / 1000) * 1000 : Math.round(v / 100) * 100) : Math.max(1, Math.round(v));
  /* вся арифметика лаборатории */
  function calcLab(P) {
    const m = SD.LLM_SIZES[P.model], M0 = MEM[P.model], gpus = P.vram / GPU_GB;
    const inTok = Math.max(0, P.ctx - P.out);
    const T = P.ttft + P.out / P.speed, conc = P.rps * T;
    const memGb = P.ctx * M0.kv / 1000, freeGb = P.vram * SPARE - M0.w, seatsMem = freeGb > 0 ? Math.floor(freeGb / memGb) : 0;
    const tokSrv = m.gpuTok * gpus, work = P.out + inTok * 0.08, capSrv = tokSrv / work, seatsSpeed = capSrv * T;
    const seats = Math.min(seatsMem, seatsSpeed);
    const servers = seats > 0 ? Math.max(1, Math.ceil(conc / (seats * TARGET) - 1e-9)) : Infinity;
    const self = isFinite(servers) ? servers * gpus * SD.GPU_COST : Infinity;
    const api = P.rps * MONTH * (inTok * m.pIn + P.out * m.pOut) / 1e6;
    const tier = P.rps / TARGET;
    /* очередь: серверы под среднюю нагрузку (пик ÷ 3), в часовой пик задачи копятся */
    const qServers = seats > 0 ? Math.max(1, Math.ceil(conc / 3 / (seats * TARGET) - 1e-9)) : Infinity;
    const qCap = isFinite(qServers) ? qServers * seats / T : 0;
    const qWait = P.rps > qCap && qCap > 0 ? (P.rps - qCap) * 3600 / qCap : 0;
    return { m, M0, gpus, inTok, T, conc, memGb, freeGb, seatsMem, tokSrv, work, capSrv, seatsSpeed, seats, servers, self, api, tier, qServers, qWait };
  }
  /* пачка: сервер ведёт сразу b разговоров. Всего печатает Tmax·b/(b+h) токенов/с, каждому — Tmax/(b+h).
     Кривая проходит через «одному — скорость модели при обычной пачке» и «одному в одиночку — в 1,4 раза быстрее» */
  function curve(P) {
    const m = SD.LLM_SIZES[P.model], tokSrv = m.gpuTok * P.vram / GPU_GB, b0 = Math.max(1.5, tokSrv / P.speed);
    const h = Math.max(1, (b0 - 1.4) / 0.4), Tmax = P.speed * (b0 + h);
    return { b0, h, Tmax, v: b => Tmax / (b + h), tot: b => Tmax * b / (b + h) };
  }
  function batchOf(P, b) {
    const c = curve(P), r = calcLab(P), v = c.v(b), T = P.ttft + P.out / v, conc = P.rps * T;
    const seats = Math.min(b, r.seatsMem), servers = seats >= 1 ? Math.max(1, Math.ceil(conc / (seats * TARGET) - 1e-9)) : Infinity;
    return { v, T, conc, seats, servers, tot: c.tot(b), cost: isFinite(servers) ? servers * r.gpus * SD.GPU_COST : Infinity, memCap: b > r.seatsMem };
  }
  function bestBatch(P) {
    let best = null;
    for (let b = 1; b <= 256; b++) { const o = batchOf(P, b); if (o.T <= 10 && isFinite(o.servers) && (!best || o.servers < best.servers)) best = { b, servers: o.servers }; }
    return best;
  }
  const ANSWER = 'По вашему обороту выгоднее тариф «Бизнес»: обслуживание 990 ₽ в месяц, переводы до 1 млн ₽ без комиссии и кэшбэк 1 % на рекламу. «Старт» дешевле, но комиссия 0,5 % съест разницу уже при 200 тыс. ₽ оборота. Сменить тариф можно в приложении: Счета → Тариф → Сменить.';
  const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
  const TASKS = [
    { id: 'conc', text: 'Получи больше 100 разговоров одновременно при нагрузке меньше 10 вопросов в секунду' },
    { id: 'mem', text: 'Сделай так, чтобы места на сервере кончались по памяти, а не по скорости' },
    { id: 'stream', text: 'Ответ дольше 10 секунд, а первое слово — быстрее секунды: выбери подходящий способ отдачи' },
    { id: 'queue', text: 'Ответ дольше 30 секунд: отдай его через очередь с уведомлением' },
    { id: 'even', text: 'Найди нагрузку, при которой свои видеокарты и API стоят почти одинаково (±20 %)' },
    { id: 'batch', text: 'При 30 вопросах в секунду на вкладке «Пачка» уложи весь ответ в 10 секунд самым маленьким числом серверов' }
  ];

  function mountLab(el, api) {
    /* открыли снова — продолжаем с теми же ползунками; из «Как посчитать» приходят числа уровня */
    const P = Object.assign(DEF(), LASTP || {}, PENDING || {});
    LASTP = P;
    if (PENDING) PENDING = null;
    if (!P.batch) P.batch = Math.round(curve(P).b0);
    let anim = null, alive = true;
    const stop = () => { if (anim) cancelAnimationFrame(anim); anim = null; };
    el.innerHTML = '<div class="eai" id="eaiRoot"></div>';
    const root = el.querySelector('#eaiRoot');
    const calm = () => document.documentElement.classList.contains('calm');

    const sl = (k, label, val, min, max, step, outTxt, small) => `<label class="eai-sl"><span>${esc(label)}<output id="eaiO_${k}">${outTxt}</output></span><input type="range" id="eaiR_${k}" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}" aria-label="${esc(label)}">${small ? `<small id="eaiS_${k}">${small}</small>` : ''}</label>`;
    const outOf = k => k === 'rps' ? `${num(P.rps)}/с` : k === 'out' ? `${num(P.out)} ток.` : k === 'speed' ? `${P.speed} ток/с` : k === 'ttft' ? sec(P.ttft) : k === 'ctx' ? `${num(P.ctx)} ток.` : k === 'vram' ? `${P.vram} ГБ` : k === 'batch' ? `${P.batch}` : '';
    const memNote = () => { const M0 = MEM[P.model]; return `память на разговор: ${num(P.ctx)} × ${comma(M0.kv)} МБ ≈ ${gbf(P.ctx * M0.kv / 1000)} ГБ`; };
    const vramNote = () => { const M0 = MEM[P.model]; return `${P.vram / GPU_GB} ${plural(P.vram / GPU_GB, GPUW)} по 80 ГБ; модель занимает ≈ ${M0.w} ГБ`; };

    function controls() {
      return `<div class="eai-ctl"><div class="eai-pre" role="group" aria-label="Модель">${['small', 'medium', 'large'].map(k => `<button type="button" data-eaim="${k}" aria-pressed="${P.model === k}">${{ small: 'Малая 8B', medium: 'Средняя 70B', large: 'Большая' }[k]}</button>`).join('')}</div>
        ${P.from ? `<p class="eai-cap">Числа уровня «${esc(P.from)}» из «Как посчитать».</p>` : ''}
        ${sl('rps', 'Вопросов в секунду (пик)', toPos('rps', P.rps), 0, 1000, 1, outOf('rps'))}
        ${sl('out', 'Длина ответа', toPos('out', P.out), 0, 1000, 1, outOf('out'), `≈ ${num(P.out / WPT)} слов`)}
        ${sl('speed', 'Скорость печати одному разговору', P.speed, 10, 250, 5, outOf('speed'))}
        ${sl('ttft', 'До первого слова (TTFT)', P.ttft, 0.1, 5, 0.05, outOf('ttft'))}
        ${sl('ctx', 'Контекст разговора: вопрос + документы + ответ', toPos('ctx', P.ctx), 0, 1000, 1, outOf('ctx'), memNote())}
        ${sl('vram', 'Видеопамять одного сервера модели', P.vram, 80, 640, 80, outOf('vram'), vramNote())}
      </div>`;
    }
    function tabs() {
      return `<div class="lt-tabs" role="tablist" aria-label="Вкладки"><button type="button" role="tab" data-eait="calc" aria-selected="${P.tab === 'calc'}">Расчёт и что видит человек</button><button type="button" role="tab" data-eait="batch" aria-selected="${P.tab === 'batch'}">Пачка: скорость против цены</button></div>`;
    }
    function draw() {
      stop();
      const body = P.tab === 'batch'
        ? `<div class="eai-grid">${controls()}<div class="eai-out"><label class="eai-sl"><span>Сервер ведёт сразу — пачка<output id="eaiO_batch">${outOf('batch')}</output></span><input type="range" id="eaiR_batch" data-k="batch" min="0" max="1000" step="1" value="${toPos('batch', P.batch)}" aria-label="Сколько разговоров сервер ведёт сразу"><small>Сколько разговоров сервер модели печатает одновременно (в vLLM — max_num_seqs)</small></label><div id="eaiBatch"></div></div></div>`
        : `<div class="eai-grid">${controls()}<div class="eai-out" id="eaiOut"></div></div><h4 style="margin:4px 0 0">Как отдаём ответ</h4><div class="eai-mode" role="group" aria-label="Как отдаём ответ">${[['sync', 'Синхронно'], ['stream', 'Поток (SSE)'], ['queue', 'Очередь + уведомление']].map(([k, t]) => `<button type="button" data-eaimode="${k}" aria-pressed="${P.mode === k}">${t}</button>`).join('')}<button type="button" class="linkish" data-eaiplay>▶ Показать ещё раз</button></div><div class="eai-view"><div class="eai-phone" aria-live="polite"><div class="eai-msg me">Какой тариф мне выгоднее при обороте 500 тыс. ₽ в месяц?</div><div id="eaiBot"></div></div><div class="eai-tl"><div class="cai-bar" aria-hidden="true"><i class="wait" id="eaiTw" style="width:0"></i><i id="eaiTf" style="width:0"></i></div><div class="cai-row"><span id="eaiTn">0 с</span><span id="eaiTs"></span></div><p class="eai-see" id="eaiSee"></p></div></div>`;
      root.innerHTML = tabs() + body;
      update(true);
    }
    /* пересчёт: меняются только выводы, ползунки не перерисовываются (фокус и перетаскивание не теряются) */
    function update(replay) {
      const r = calcLab(P);
      ['rps', 'out', 'speed', 'ttft', 'ctx', 'vram', 'batch'].forEach(k => { const o = $('eaiO_' + k); if (o) o.textContent = outOf(k); });
      const sOut = $('eaiS_out'); if (sOut) sOut.textContent = `≈ ${num(P.out / WPT)} слов`;
      const sCtx = $('eaiS_ctx'); if (sCtx) sCtx.textContent = memNote();
      const sV = $('eaiS_vram'); if (sV) sV.textContent = vramNote();
      if (P.tab === 'batch') { batchView(); return; }
      const o = $('eaiOut'); if (!o) return;
      const lim = r.seatsMem < r.seatsSpeed ? 'память' : 'скорость';
      const tile = (t, v, e, cls) => `<div class="eai-tile ${cls || ''}"><small>${t}</small><b>${v}</b>${e ? `<em>${e}</em>` : ''}</div>`;
      let h = `<div class="eai-tiles" aria-live="polite">${tile('Первое слово', sec(P.ttft), 'если отдаём потоком')}${tile('Весь ответ', sec(r.T), `${num(P.out)} ÷ ${P.speed} + ${fx(P.ttft)}`, r.T > 30 ? 'bad' : r.T > 10 ? 'warn' : '')}${tile('Одновременно', fx(r.conc), 'разговоров = поток × время')}${tile('Мест на сервер', r.seats >= 1 ? fx(r.seats) : '0', r.seatsMem < 1 ? 'модель + разговор не влезают' : `память ${num(r.seatsMem)} · скорость ${fx(r.seatsSpeed)} → ${lim}`, r.seatsMem < 1 ? 'bad' : '')}${tile('Серверов модели', isFinite(r.servers) ? r.servers : '—', isFinite(r.servers) ? `${r.servers * r.gpus} ${plural(r.servers * r.gpus, GPUW)}` : 'увеличь видеопамять или сократи контекст', isFinite(r.servers) ? '' : 'bad')}${tile('Цена в месяц', isFinite(r.self) ? usd(r.self) : '—', `свои видеокарты · API ${usd(r.api)}`)}</div>`;
      h += `<ol class="eai-f"><li>Весь ответ = ${fx(P.ttft)} + ${num(P.out)} ÷ ${P.speed} = <b>${sec(r.T)}</b></li><li>Одновременно = ${num(P.rps)}/с × ${fx(r.T)} с = <b>${fx(r.conc)}</b> ${plS(fx(r.conc), DW)} (закон Литтла)</li><li>Память на разговор = ${num(P.ctx)} × ${comma(r.M0.kv)} МБ = <b>${gbf(r.memGb)} ГБ</b>; свободно на сервере ${P.vram} × 0,9 − ${r.M0.w} = ${num(r.freeGb)} ГБ → <b>${num(r.seatsMem)}</b> ${plS(num(r.seatsMem), PW)} по памяти</li><li>Скорость: сервер печатает ≈ ${num(r.tokSrv)} токенов/с на всех, ответ — ${pn(r.work, TW)} работы (печать + 8 % входа) → ≈ ${pn(r.capSrv, QW, fx)} в секунду → <b>${fx(r.seatsSpeed)}</b> ${plS(fx(r.seatsSpeed), PW)} по скорости</li><li>Серверов = ${fx(r.conc)} ÷ (${fx(r.seats)} × 0,75) → <b>${isFinite(r.servers) ? r.servers : '—'}</b>; у поставщика нужен лимит ≈ ${pn(r.tier, ZW)} в секунду</li><li>Цена: свои ${isFinite(r.servers) ? `${r.servers} × ${r.gpus} × $${num(SD.GPU_COST)} = <b>${usd(r.self)}</b>` : '—'}; API ${num(P.rps)} × 2,63 млн × (${num(r.inTok)} × $${comma(r.m.pIn)} + ${num(P.out)} × $${comma(r.m.pOut)}) ÷ 1 млн = <b>${usd(r.api)}</b></li></ol>`;
      /* столики: серверы и занятые места; одна клетка — k разговоров, если их много */
      if (isFinite(r.servers) && r.seats >= 1) {
        const seatsI = Math.max(1, Math.floor(r.seats)), totalSeats = r.servers * seatsI, show = Math.min(r.servers, 12);
        const k = Math.max(1, Math.ceil(Math.max(totalSeats, r.conc) / 384));
        const per = Math.max(1, Math.ceil(seatsI / k)), busy = Math.round(r.conc / k);
        let left = busy, cells = '';
        for (let s = 0; s < show; s++) { let c = ''; for (let j = 0; j < per; j++) { c += `<i class="${left > 0 ? 'on' : ''}"></i>`; left--; } cells += `<div class="eai-srv" style="grid-template-columns: repeat(${Math.min(8, per)}, 9px)" title="сервер ${s + 1}">${c}</div>`; }
        h += `<div><div class="eai-seats" aria-hidden="true">${cells}</div><p class="eai-cap">${show < r.servers ? `Показаны 12 из ${r.servers} серверов. ` : ''}Клетка — ${k === 1 ? 'место для одного разговора' : `${k} мест`}; закрашено — занято в пик (≈ ${pn(r.conc, DW, fx)} на ${pn(r.servers * r.seats, PW)}: загрузка ${pct(r.conc / (r.servers * r.seats))}).</p></div>`;
      }
      o.innerHTML = h;
      modeView(r, replay);
    }
    /* что видит человек: телефон и шкала времени; показ сжат до ≈ 6 секунд */
    function modeView(r, replay) {
      const bot = $('eaiBot'), see = $('eaiSee'); if (!bot || !see) return;
      const T = r.T, wq = P.mode === 'queue' ? Math.min(r.qWait, 3600 * 4) : 0, total = T + wq;
      const lines = {
        sync: `<b>Синхронно:</b> ${sec(T)} пустого экрана с крутилкой, потом весь текст сразу.${T > 30 ? ' Дольше 30 секунд — шлюз или браузер оборвут соединение по таймауту, человек увидит ошибку.' : T > 10 ? ' Дольше 10 секунд — многие закроют экран и напишут в поддержку.' : T > 1.5 ? ' Пауза заметна: человек думает, что зависло.' : ' Ответ короткий — так можно.'}`,
        stream: `<b>Поток (SSE):</b> первое слово через ${sec(P.ttft)}, дальше текст бежит со скоростью ${P.speed} токенов/с — быстрее, чем человек читает. Соединение держится ${sec(T)}: открытых соединений у сервиса одновременно ≈ ${fx(r.conc)}.${T > 60 ? ' Но ответ дольше минуты — человек может уйти, а соединение оборваться: такое лучше в очередь.' : ''}`,
        queue: `<b>Очередь:</b> сразу «Приняли, пришлём уведомлением» — экран можно закрыть. Серверы держат под среднюю нагрузку: ${isFinite(r.qServers) ? r.qServers : '—'} вместо ${isFinite(r.servers) ? r.servers : '—'}; ${r.qWait > 1 ? `в часовой пик задачи ждут до ≈ ${r.qWait >= 60 ? num(r.qWait / 60) + ' мин' : sec(r.qWait)}, потом очередь рассасывается` : 'очередь почти не копится'}. Ответ придёт через ≈ ${total >= 60 ? num(total / 60) + ' мин' : sec(total)}.`
      };
      see.className = 'eai-see' + ((P.mode === 'sync' && T > 10) || (P.mode === 'stream' && T > 60) ? ' bad' : '');
      see.innerHTML = lines[P.mode];
      $('eaiTs').textContent = P.mode === 'queue' ? `ответ ≈ ${total >= 60 ? num(total / 60) + ' мин' : sec(total)}` : `весь ответ ${sec(T)}`;
      stop();
      const words = ANSWER.split(' ');
      /* состояние экрана в момент t (секунды настоящего времени); k — во сколько раз ускорен показ */
      const paint = (t, k) => {
        let html;
        if (P.mode === 'queue') {
          html = '<div class="eai-msg bot">Приняли вопрос №1042. Пришлём ответ уведомлением — экран можно закрыть.</div>';
          if (t >= total) html += `<div class="eai-msg note">${BELL}<span><b>Готов ответ на вопрос №1042.</b> ${esc(ANSWER)}</span></div>`;
        } else if (P.mode === 'sync') html = t >= T ? `<div class="eai-msg bot">${esc(ANSWER)}</div>` : '<div class="eai-msg bot"><span class="eai-dots" aria-label="печатает"><i></i><i></i><i></i></span></div>';
        else {
          const f = t < P.ttft ? 0 : Math.min(1, (t - P.ttft) / Math.max(0.01, T - P.ttft));
          html = f <= 0 ? '<div class="eai-msg bot"><span class="eai-dots" aria-label="думает"><i></i><i></i><i></i></span></div>' : `<div class="eai-msg bot">${esc(words.slice(0, Math.max(1, Math.round(words.length * f))).join(' '))}</div>`;
        }
        $('eaiBot').innerHTML = html;
        const tf = $('eaiTf'), tw = $('eaiTw'), tn = $('eaiTn');
        const firstAt = P.mode === 'queue' ? 0.1 : P.mode === 'sync' ? T : P.ttft;
        tw.style.width = (Math.min(t, total) / Math.max(total, 0.01) * 100).toFixed(1) + '%';
        tf.style.width = (t >= firstAt ? Math.max(0, Math.min(t, total) - firstAt) / Math.max(total, 0.01) * 100 : 0).toFixed(1) + '%';
        tf.style.left = (Math.min(firstAt, total) / Math.max(total, 0.01) * 100).toFixed(1) + '%';
        tn.textContent = `${t >= 60 ? num(t / 60) + ' мин' : sec(t)}${k && k > 1.05 && t < total ? ` · показываю в ${num(k)} раз${[2, 3, 4].includes(Math.round(k) % 10) && ![12, 13, 14].includes(Math.round(k) % 100) ? 'а' : ''} быстрее` : ''}`;
      };
      /* ползунки двигают — сразу итог; показ по шагам — только по кнопке, смене режима и при открытии */
      if (!replay || calm()) { paint(total, 0); return; }
      const show = Math.min(6, Math.max(1.5, total)), k = total / show, t0 = performance.now();
      const frame = now => {
        if (!alive || !$('eaiBot')) { stop(); return; }
        const t = Math.min(total, (now - t0) / 1000 * k);
        paint(t, k);
        anim = t < total ? requestAnimationFrame(frame) : null;
      };
      anim = requestAnimationFrame(frame);
    }
    /* вкладка «Пачка»: два маленьких графика с одной осью каждый (не две шкалы на одном) */
    function batchView() {
      const box = $('eaiBatch'); if (!box) return;
      const o = batchOf(P, P.batch), c = curve(P), r = calcLab(P), best = bestBatch(P);
      const xs = [1, 2, 4, 8, 16, 32, 64, 128, 256];
      const chart = (id, title, f, cls, unit) => {
        const W = 300, H = 130, pl = 40, pr = 10, pt = 10, pb = 22, top = Math.max(...xs.map(f)) * 1.05, p10 = Math.pow(10, Math.floor(Math.log10(top))), max = [1, 2, 2.5, 5, 10].map(k => k * p10).find(v => v >= top);
        const X = b => pl + Math.log2(b) / 8 * (W - pl - pr), Y = v => pt + (1 - v / max) * (H - pt - pb);
        let path = ''; for (let i = 0; i <= 64; i++) { const b = Math.pow(2, i / 8); path += (i ? 'L' : 'M') + X(b).toFixed(1) + ' ' + Y(f(b)).toFixed(1); }
        const yt = [0, max / 2, max].map(v => `<line class="ax" x1="${pl}" x2="${W - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="tk" x="${pl - 4}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${num(v)}</text>`).join('');
        const xt = xs.filter((b, i) => i % 2 === 0).map(b => `<text class="tk" x="${X(b).toFixed(1)}" y="${H - 6}" text-anchor="middle">${b}</text>`).join('');
        const v = f(P.batch), mx = X(P.batch), my = Y(v);
        return `<div class="eai-chart"><h5>${title}</h5><svg viewBox="0 0 ${W} ${H}" data-eaich="${id}" role="img" aria-label="${esc(title)}: при пачке ${P.batch} — ${num(v)} ${unit}">${yt}${xt}<path class="ln ${cls}" d="${path}"/><line class="xh" id="eaiX_${id}" x1="0" x2="0" y1="${pt}" y2="${H - pb}" style="display:none"/><circle class="mk ${cls}" cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="5"/><text class="vl" x="${(mx + (mx > W - 80 ? -8 : 8)).toFixed(1)}" y="${(my - 8).toFixed(1)}" text-anchor="${mx > W - 80 ? 'end' : 'start'}">${num(v)}</text></svg><p class="eai-rd" id="eaiRd_${id}">наведи на график — значение для любой пачки</p></div>`;
      };
      const tile = (t, v, e, cls) => `<div class="eai-tile ${cls || ''}"><small>${t}</small><b>${v}</b>${e ? `<em>${e}</em>` : ''}</div>`;
      box.innerHTML = `<div class="eai-ch">${chart('v', 'Скорость печати одному разговору, токенов/с', c.v, 'a', 'токенов/с')}${chart('t', 'Сервер печатает всего, токенов/с', c.tot, 'b', 'токенов/с')}</div>
        <div class="eai-tiles" style="margin-top:8px">${tile('Одному разговору', `${num(o.v)} ток/с`, `при пачке ${P.batch}`)}${tile('Весь ответ', sec(o.T), `${fx(P.ttft)} + ${num(P.out)} ÷ ${num(o.v)}`, o.T > 10 ? 'warn' : '')}${tile('Одновременно', fx(o.conc), 'разговоров = поток × время')}${tile('Серверов', isFinite(o.servers) ? o.servers : '—', o.memCap ? `пачку режет память: мест ${num(r.seatsMem)}` : `по ${P.batch} разговоров, запас 25 %`, isFinite(o.servers) ? '' : 'bad')}${tile('Цена в месяц', isFinite(o.cost) ? usd(o.cost) : '—', 'свои видеокарты')}</div>
        <p class="eai-see">Пачка больше — сервер печатает больше токенов всего (каждый токен дешевле), но каждому разговору медленнее: ответ дольше, а значит, и разговоров одновременно больше. Чат держат пачку поменьше; ночные задачи — разметку, отчёты, пакетный API поставщика примерно за полцены — гонят огромными пачками.${best ? ` Уложиться в 10 секунд при ${num(P.rps)} вопросах/с самым маленьким числом серверов (${best.servers}) — пачка до ≈ ${best.b}.` : ' В 10 секунд при таких числах не уложиться: сократи ответ или возьми модель быстрее.'}</p>`;
      box.querySelectorAll('[data-eaich]').forEach(svg => {
        const id = svg.dataset.eaich, f = id === 'v' ? c.v : c.tot, xh = $('eaiX_' + id), rd = $('eaiRd_' + id);
        const move = e => {
          const bb = svg.getBoundingClientRect(), x = (e.clientX - bb.left) / bb.width * 300;
          const b = Math.max(1, Math.min(256, Math.round(Math.pow(2, (x - 40) / 250 * 8))));
          const X = 40 + Math.log2(b) / 8 * 250;
          xh.setAttribute('x1', X.toFixed(1)); xh.setAttribute('x2', X.toFixed(1)); xh.style.display = '';
          const bo = batchOf(P, b);
          rd.textContent = `пачка ${b}: ${num(f(b))} токенов/с ${id === 'v' ? 'одному' : 'всего'} · весь ответ ${sec(bo.T)} · серверов ${isFinite(bo.servers) ? bo.servers : '—'}`;
        };
        svg.addEventListener('pointermove', move);
        svg.addEventListener('pointerleave', () => { xh.style.display = 'none'; rd.textContent = 'наведи на график — значение для любой пачки'; });
      });
    }
    /* задания проверяем только после действий человека */
    function tasks() {
      const r = calcLab(P);
      if (r.conc > 100 && P.rps < 10) api.done('conc');
      if (r.seatsMem >= 1 && r.seatsMem < r.seatsSpeed) api.done('mem');
      if (P.mode === 'stream' && r.T > 10 && P.ttft < 1) api.done('stream');
      if (P.mode === 'queue' && r.T > 30) api.done('queue');
      if (isFinite(r.self) && Math.abs(r.self - r.api) / Math.max(r.self, r.api) <= 0.2) api.done('even');
      if (P.tab === 'batch' && P.rps >= 27) { const o = batchOf(P, P.batch), best = bestBatch(P); if (best && o.T <= 10 && o.servers === best.servers) api.done('batch'); }
    }
    const onInput = e => {
      const t = e.target; if (!t.matches || !t.matches('input[type="range"][data-k]')) return;
      const k = t.dataset.k, v = +t.value;
      if (LOG[k]) P[k] = niceV(k, fromPos(k, v)); else P[k] = k === 'ttft' ? Math.round(v * 100) / 100 : v;
      if (k === 'ctx' && P.out > P.ctx) P.out = P.ctx;
      update(false); tasks();
    };
    const onClick = e => {
      const b = e.target.closest('button'); if (!b || !root.contains(b)) return;
      if (b.dataset.eait) { P.tab = b.dataset.eait; draw(); return; }
      if (b.dataset.eaim) { Object.assign(P, PRESET(b.dataset.eaim)); P.batch = Math.round(curve(P).b0); P.from = ''; draw(); tasks(); return; }
      if (b.dataset.eaimode) { P.mode = b.dataset.eaimode; root.querySelectorAll('[data-eaimode]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); update(true); tasks(); return; }
      if (b.hasAttribute('data-eaiplay')) { update(true); }
    };
    root.addEventListener('input', onInput);
    root.addEventListener('click', onClick);
    draw();
    LAB = { set(p) { Object.assign(P, p); if (p.model && !p.batch) P.batch = Math.round(curve(P).b0); P.tab = 'calc'; draw(); }, state: () => Object.assign({}, P), calc: () => calcLab(P) };
    return () => { alive = false; stop(); LAB = null; };
  }

  SD.LAB_FINGERS = SD.LAB_FINGERS || {};
  SD.LAB_FINGERS.estai = FG;
  SD.LABS = SD.LABS || [];
  SD.LABS.push({
    id: 'estai', title: 'Оценка на салфетке: ИИ', lede: 'Токены, время ответа, разговоры одновременно, видеопамять', dive: 'llm',
    intro: 'Та же оценка на салфетке, но для языковой модели: ответ идёт секунды, поэтому считаем разговоры одновременно (закон Литтла), места на сервере по видеопамяти и скорости, серверы и цену. Двигай ползунки — формулы ниже пересчитываются, а телефон показывает, что видит человек при синхронном ответе, потоке и очереди. Вкладка «Пачка» — про выбор между скоростью ответа и ценой.',
    tasks: TASKS,
    mount: mountLab
  });

  SD.calcAi = { open, model, steps, calcLab, batchOf, bestBatch, curve, MEM, FG, lab: () => LAB };
})();
