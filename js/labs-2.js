/* Лаборатория, часть 2: Raft, фильтр Блума, LSM-дерево, token bucket, Snowflake ID. */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fnv = s => SD.labHash(s);
  const h2 = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h >>> 0; };

  /* ---------- 4. Raft ---------- */
  SD.LABS.push({
    id: 'raft', title: 'Raft: выборы и журнал', lede: 'Лидер, кворум, раздел сети', dive: 'consensus',
    intro: 'Пять узлов договариваются о журнале. Лидер шлёт heartbeat, без него последователи по таймауту объявляют выборы. Запись фиксируется, когда её подтвердило большинство. Кликни по узлу, чтобы уронить или поднять его.',
    tasks: [{ id: 'reelect', text: 'Урони лидера и дождись выборов нового' }, { id: 'commit', text: 'Отправь запись и дождись, пока её зафиксирует большинство' }, { id: 'minority', text: 'Раздели сеть и убедись, что лидер в меньшинстве не может зафиксировать запись' }, { id: 'stepdown', text: 'Восстанови сеть: старый лидер должен стать последователем' }],
    mount(el, api) {
      const N = 5, MAJ = 3;
      const rt = () => 15 + Math.floor(Math.random() * 16);
      const nodes = Array.from({ length: N }, (_, i) => ({ id: i, up: true, role: 'follower', term: 0, voted: null, timer: rt() + i * 3, log: [], commit: 0, votes: 0, hb: 0, match: {} }));
      let part = false, msgs = [], running = true, killedTerm = null, minorityLeader = null, mw = null, val = 0;
      const side = i => (i < 2 ? 0 : 1);
      const reach = (a, b) => nodes[a].up && nodes[b].up && (!part || side(a) === side(b));
      const leader = () => nodes.find(n => n.up && n.role === 'leader');
      const send = (a, b, type) => msgs.push({ a, b, type, age: 0 });
      function upToDate(c, v) { const lc = c.log[c.log.length - 1], lv = v.log[v.log.length - 1]; const ct = lc ? lc.term : 0, vt = lv ? lv.term : 0; return ct > vt || (ct === vt && c.log.length >= v.log.length); }
      function step() {
        nodes.forEach(n => {
          if (!n.up) return;
          if (n.role === 'leader') {
            if (++n.hb % 5 === 0) nodes.forEach(f => {
              if (f.id === n.id || !reach(n.id, f.id)) return;
              send(n.id, f.id, 'hb');
              if (f.term > n.term) { n.term = f.term; n.role = 'follower'; n.timer = rt(); return; }
              f.term = n.term; f.role = 'follower'; f.voted = f.voted; f.timer = rt();
              f.log = n.log.slice(); n.match[f.id] = n.log.length;
              f.commit = Math.min(n.commit, f.log.length);
            });
            if (n.role === 'leader') {
              for (let i = n.log.length; i > n.commit; i--) {
                const acks = 1 + nodes.filter(f => f.id !== n.id && (n.match[f.id] || 0) >= i && reach(n.id, f.id)).length;
                if (acks >= MAJ && n.log[i - 1].term === n.term) { n.commit = i; api.done('commit'); break; }
              }
            }
          } else if (--n.timer <= 0) {
            n.role = 'candidate'; n.term++; n.voted = n.id; n.votes = 1; n.timer = rt();
            nodes.forEach(v => {
              if (v.id === n.id || !reach(n.id, v.id)) return;
              send(n.id, v.id, 'vote');
              if (v.term < n.term) { v.term = n.term; v.voted = null; if (v.role !== 'follower') v.role = 'follower'; }
              if (v.voted === null && upToDate(n, v)) { v.voted = n.id; v.timer = rt(); n.votes++; send(v.id, n.id, 'yes'); }
            });
            if (n.votes >= MAJ) { n.role = 'leader'; n.hb = 0; n.match = {}; if (killedTerm !== null && n.term > killedTerm) api.done('reelect'); }
          }
        });
        if (part && mw) {
          const ml = nodes[mw.leader];
          if (ml.commit < mw.index) { if (++mw.ticks >= 30) { api.done('minority'); mw = null; } } else mw = null;
        }
        if (!part && minorityLeader !== null && nodes[minorityLeader].role === 'follower' && nodes.some(n => n.role === 'leader' && n.id !== minorityLeader)) { api.done('stepdown'); minorityLeader = null; }
        msgs.forEach(m => m.age++); msgs = msgs.filter(m => m.age < 6);
      }
      const pos = i => { const t = i / N * Math.PI * 2 - Math.PI / 2; return { x: 170 + Math.cos(t) * 110, y: 150 + Math.sin(t) * 110 }; };
      function draw() {
        const L = leader();
        const col = { leader: 'var(--accent)', candidate: 'var(--warn)', follower: 'var(--border-strong)' };
        el.innerHTML = `<div class="lab-split"><svg viewBox="0 0 340 300" class="lab-svg" aria-label="Узлы Raft">
          ${part ? '<line x1="95" y1="0" x2="95" y2="300" stroke="var(--bad)" stroke-dasharray="6 4"></line>' : ''}
          ${msgs.map(m => { const a = pos(m.a), b = pos(m.b); return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${m.type === 'hb' ? 'var(--accent)' : m.type === 'yes' ? 'var(--ok)' : 'var(--warn)'}" stroke-width="1.5" opacity="${1 - m.age / 6}"></line>`; }).join('')}
          ${nodes.map(n => { const p = pos(n.id); return `<g data-rn="${n.id}" style="cursor:pointer"><circle cx="${p.x}" cy="${p.y}" r="30" fill="${n.up ? 'var(--surface-2)' : 'var(--bad-soft)'}" stroke="${n.up ? col[n.role] : 'var(--bad)'}" stroke-width="${n.role === 'leader' ? 3 : 2}"></circle>
            <text x="${p.x}" y="${p.y - 8}" text-anchor="middle" class="lab-small">${n.up ? ({ leader: 'лидер', candidate: 'кандидат', follower: 'ведомый' })[n.role] : 'лежит'}</text>
            <text x="${p.x}" y="${p.y + 7}" text-anchor="middle" class="lab-big">S${n.id + 1}</text>
            <text x="${p.x}" y="${p.y + 20}" text-anchor="middle" class="lab-small">срок ${n.term}</text></g>`; }).join('')}
          </svg><div class="lab-side">
          <div class="row-btns"><button type="button" class="btn primary" id="rfW">Запрос клиента</button><button type="button" class="btn" id="rfP">${part ? 'Восстановить сеть' : 'Разделить сеть (S1–S2 | S3–S5)'}</button><button type="button" class="btn ghost" id="rfR">${running ? 'Пауза' : 'Пуск'}</button></div>
          <p class="note">${L ? `Лидер: S${L.id + 1}, срок ${L.term}.` : 'Лидера нет — идут выборы.'} Клик по узлу роняет его.</p>
          <div class="raft-logs">${nodes.map(n => `<div><b>S${n.id + 1}</b>${n.log.map((e, i) => `<i class="${i < n.commit ? 'c' : ''}" title="срок ${e.term}">${e.v}</i>`).join('') || '<small>пусто</small>'}</div>`).join('')}</div>
          <p class="note">Закрашенные записи зафиксированы (есть на большинстве). Число — значение, цвет рамки — срок.</p></div></div>`;
        el.querySelectorAll('[data-rn]').forEach(g => g.onclick = () => { const n = nodes[+g.dataset.rn]; if (n.up && n.role === 'leader') killedTerm = n.term; n.up = !n.up; if (n.up) { n.role = 'follower'; n.timer = rt(); } draw(); });
        el.querySelector('#rfW').onclick = () => { const l = leader(); if (!l) { SD.app.toast('Лидера нет — запрос некуда отправить.'); return; } l.log.push({ term: l.term, v: ++val }); l.match[l.id] = l.log.length; if (part && side(l.id) === 0) { minorityLeader = l.id; mw = { leader: l.id, index: l.log.length, ticks: 0 }; } draw(); };
        el.querySelector('#rfP').onclick = () => { part = !part; if (part) { const l = leader(); if (l && side(l.id) === 0) minorityLeader = l.id; } draw(); };
        el.querySelector('#rfR').onclick = () => { running = !running; draw(); };
      }
      draw();
      const iv = setInterval(() => { if (running && !document.hidden) { step(); draw(); } }, 120);
      return () => clearInterval(iv);
    }
  });

  /* ---------- 5. Фильтр Блума ---------- */
  SD.LABS.push({
    id: 'bloom', title: 'Фильтр Блума', lede: '«точно нет» или «возможно есть»', dive: 'storage',
    intro: 'Битовый массив из m бит и k хэш-функций. Добавленное слово зажигает k бит. Проверка: если хоть один бит не горит — слова точно нет. Если горят все — возможно есть. Так LSM-базы не читают лишние файлы, а краулеры не обходят страницу дважды.',
    tasks: [{ id: 'add', text: 'Добавь хотя бы 10 слов' }, { id: 'fp', text: 'Найди ложное срабатывание: слово не добавлено, а фильтр говорит «возможно есть»' }, { id: 'tune', text: 'При m = 128 и 15+ словах добейся измеренной доли ложных срабатываний меньше 3 %' }],
    mount(el, api) {
      let m = 64, k = 3, words = [], bits = new Array(256).fill(0), last = [], msg = '', measured = null;
      const pos = w => { const a = fnv(w), b = h2(w) | 1; return Array.from({ length: k }, (_, i) => (a + i * b) % m); };
      const rebuild = () => { bits = new Array(256).fill(0); words.forEach(w => pos(w).forEach(p => { bits[p] = 1; })); };
      const has = w => pos(w).every(p => bits[p]);
      const SAMPLE = ['москва', 'казань', 'омск', 'тула', 'пермь', 'сочи', 'уфа', 'тверь', 'орёл', 'псков', 'калуга', 'курск', 'липецк', 'рязань', 'самара', 'томск', 'чита', 'якутск'];
      const draw = () => {
        const fill = bits.slice(0, m).filter(Boolean).length / m;
        const theory = Math.pow(1 - Math.exp(-k * words.length / m), k);
        el.innerHTML = `<div class="lab-side wide">
          <div class="row-btns"><input id="bfIn" class="lab-input" placeholder="слово" autocomplete="off"><button type="button" class="btn primary" id="bfAdd">Добавить</button><button type="button" class="btn" id="bfTest">Проверить</button><button type="button" class="btn ghost" id="bfSample">+ 10 городов</button></div>
          ${msg ? `<div class="lab-card ${msg.c}">${msg.t}</div>` : ''}
          <div class="bits" style="grid-template-columns: repeat(${Math.min(32, m)}, 1fr)">${bits.slice(0, m).map((b, i) => `<span class="${b ? 'on' : ''} ${last.includes(i) ? 'hl' : ''}" title="бит ${i}"></span>`).join('')}</div>
          <div class="lab-split2"><div class="prop"><label for="bfM">m — бит <output>${m}</output></label><input type="range" id="bfM" min="16" max="256" step="16" value="${m}"></div>
          <div class="prop"><label for="bfK">k — хэш-функций <output>${k}</output></label><input type="range" id="bfK" min="1" max="8" value="${k}"></div></div>
          <p class="note">Слов: ${words.length} · заполнено бит: ${Math.round(fill * 100)} % · теория: ложных срабатываний ≈ ${(theory * 100).toFixed(1)} % · оптимальное k ≈ ${words.length ? Math.max(1, Math.round(m / words.length * Math.LN2)) : '—'}</p>
          <div class="row-btns"><button type="button" class="btn" id="bfMeasure">Измерить на 1 000 случайных слов</button>${measured != null ? `<span class="note">Измерено: <b>${(measured * 100).toFixed(1)} %</b> ложных срабатываний</span>` : ''}</div>
          <p class="note">Добавленные: ${words.map(esc).join(', ') || 'пока нет'}</p></div>`;
        const inp = el.querySelector('#bfIn');
        const word = () => inp.value.trim().toLowerCase();
        el.querySelector('#bfAdd').onclick = () => { const w = word(); if (!w) return; if (!words.includes(w)) words.push(w); last = pos(w); last.forEach(p => { bits[p] = 1; }); msg = { t: `Добавлено «${esc(w)}»: зажглись биты ${last.join(', ')}.`, c: 'okc' }; if (words.length >= 10) api.done('add'); measured = null; draw(); };
        el.querySelector('#bfTest').onclick = () => { const w = word(); if (!w) return; last = pos(w); const yes = has(w); const fp = yes && !words.includes(w); msg = { t: yes ? (fp ? `«${esc(w)}» не добавляли, но все биты ${last.join(', ')} горят — <b>ложное срабатывание</b>. Фильтр ошибается только в эту сторону.` : `«${esc(w)}» — возможно есть (и действительно есть).`) : `«${esc(w)}» — <b>точно нет</b>: бит ${last.find(p => !bits[p])} не горит.`, c: fp ? 'badc' : 'okc' }; if (fp) api.done('fp'); draw(); };
        el.querySelector('#bfSample').onclick = () => { SAMPLE.filter(w => !words.includes(w)).slice(0, 10).forEach(w => { words.push(w); pos(w).forEach(p => { bits[p] = 1; }); }); last = []; if (words.length >= 10) api.done('add'); msg = ''; measured = null; draw(); };
        el.querySelector('#bfMeasure').onclick = () => { let fp = 0; for (let i = 0; i < 1000; i++) { const w = 'x' + Math.random().toString(36).slice(2, 9); if (has(w)) fp++; } measured = fp / 1000; if (m === 128 && words.length >= 15 && measured < 0.03) api.done('tune'); draw(); };
        el.querySelector('#bfM').onchange = e => { m = +e.target.value; rebuild(); last = []; measured = null; draw(); };
        el.querySelector('#bfK').onchange = e => { k = +e.target.value; rebuild(); last = []; measured = null; draw(); };
      };
      draw();
    }
  });

  /* ---------- 6. LSM-дерево ---------- */
  SD.LABS.push({
    id: 'lsm', title: 'LSM-дерево', lede: 'Как Cassandra и RocksDB пишут быстро', dive: 'storage',
    intro: 'Запись идёт в журнал (WAL) и в отсортированную таблицу в памяти — memtable. Когда она заполнится, её сбрасывают на диск неизменяемым файлом SSTable. Чтение проверяет memtable, потом файлы от новых к старым. Компакция сливает файлы и выбрасывает старые версии и надгробия.',
    tasks: [{ id: 'flush', text: 'Заполни memtable, чтобы она сбросилась в SSTable' }, { id: 'amp', text: 'Получи чтение, которое проверило 3 и больше файла' }, { id: 'compact', text: 'Сделай компакцию и посмотри, как упало число файлов для чтения' }, { id: 'tomb', text: 'Удали ключ и посмотри, как надгробие исчезает после компакции' }],
    mount(el, api) {
      const LIMIT = 4;
      let mem = new Map(), l0 = [], l1 = [], wal = [], bloom = true, msg = '', delSeen = null, silent = true;
      const flush = () => { if (!mem.size) return; l0.unshift([...mem.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)); mem = new Map(); wal = []; if (!silent) api.done('flush'); };
      const put = (k, v) => { wal.push(`${v === null ? 'DEL' : 'PUT'} ${k}${v === null ? '' : '=' + v}`); mem.set(k, v); if (mem.size >= LIMIT) flush(); };
      const get = k => {
        let checked = 0, skipped = 0;
        if (mem.has(k)) return { v: mem.get(k), where: 'memtable', checked: 0, skipped };
        const tables = [...l0, l1.length ? l1 : null].filter(Boolean);
        for (let i = 0; i < tables.length; i++) {
          const t = tables[i];
          if (bloom && !t.some(e => e[0] === k)) { skipped++; continue; }
          checked++;
          const e = t.find(x => x[0] === k);
          if (e) return { v: e[1], where: i < l0.length ? 'L0 #' + (i + 1) : 'L1', checked, skipped };
        }
        return { v: undefined, where: 'нигде', checked, skipped };
      };
      const compact = () => { const merged = new Map(); [...l1].forEach(([k, v]) => merged.set(k, v)); [...l0].reverse().forEach(t => t.forEach(([k, v]) => merged.set(k, v))); l1 = [...merged.entries()].filter(e => e[1] !== null).sort((a, b) => a[0] < b[0] ? -1 : 1); l0 = []; api.done('compact'); if (delSeen && !l1.some(e => e[0] === delSeen)) api.done('tomb'); };
      const table = (t, cls) => `<div class="sst ${cls || ''}">${t.map(([k, v]) => `<span class="${v === null ? 'tomb' : ''}">${esc(k)}${v === null ? ' ✝' : '=' + esc(v)}</span>`).join('')}</div>`;
      const draw = () => {
        el.innerHTML = `<div class="lab-side wide">
          <div class="row-btns"><input id="lkK" class="lab-input" placeholder="ключ (user:7)" value="user:${1 + Math.floor(Math.random() * 9)}"><input id="lkV" class="lab-input" placeholder="значение" value="v${Math.floor(Math.random() * 90 + 10)}">
          <button type="button" class="btn primary" id="lkPut">PUT</button><button type="button" class="btn" id="lkGet">GET</button><button type="button" class="btn" id="lkDel">DELETE</button><button type="button" class="btn ghost" id="lkFlush">Сбросить memtable</button><button type="button" class="btn ghost" id="lkComp">Компакция</button></div>
          <label class="switch"><input type="checkbox" id="lkBloom" ${bloom ? 'checked' : ''}><span><b>Фильтры Блума у файлов</b><small>Позволяют не открывать файлы, где ключа точно нет.</small></span></label>
          ${msg ? `<div class="lab-card ${msg.c}">${msg.t}</div>` : ''}
          <div class="lsm"><div><h4>Память: memtable (${mem.size}/${LIMIT})</h4>${table([...mem.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1), 'mem')}<h4>WAL</h4><div class="wal">${wal.map(esc).join('<br>') || '<small>пусто</small>'}</div></div>
          <div><h4>Диск: L0 (новые сверху)</h4>${l0.map(t => table(t)).join('') || '<small>пусто</small>'}</div>
          <div><h4>Диск: L1</h4>${l1.length ? table(l1) : '<small>пусто</small>'}</div></div></div>`;
        const K = () => el.querySelector('#lkK').value.trim(), V = () => el.querySelector('#lkV').value.trim();
        el.querySelector('#lkPut').onclick = () => { if (!K()) return; put(K(), V() || 'x'); msg = { t: `PUT ${esc(K())}: запись в WAL и memtable — без поиска по диску.`, c: 'okc' }; draw(); };
        el.querySelector('#lkDel').onclick = () => { if (!K()) return; put(K(), null); delSeen = K(); msg = { t: `DELETE ${esc(K())}: старые значения на диске не трогаем, пишем надгробие. Удалится при компакции.`, c: 'okc' }; draw(); };
        el.querySelector('#lkGet').onclick = () => { if (!K()) return; const r = get(K()); if (r.checked >= 3) api.done('amp'); msg = { t: `GET ${esc(K())}: ${r.v === undefined || r.v === null ? 'не найдено' : '= ' + esc(r.v)} · найдено в ${r.where} · открыто файлов: <b>${r.checked}</b>${bloom ? `, пропущено фильтром Блума: ${r.skipped}` : ''}.`, c: r.checked >= 3 ? 'badc' : 'okc' }; draw(); };
        el.querySelector('#lkFlush').onclick = () => { flush(); msg = { t: 'memtable сброшена в новый файл L0.', c: 'okc' }; draw(); };
        el.querySelector('#lkComp').onclick = () => { compact(); msg = { t: 'Компакция слила все файлы в L1: старые версии и надгробия выброшены, чтению нужен один файл.', c: 'okc' }; draw(); };
        el.querySelector('#lkBloom').onchange = e => { bloom = e.target.checked; draw(); };
      };
      ['user:1', 'user:2', 'user:3', 'user:4', 'user:2', 'user:5', 'user:1', 'user:6'].forEach((k, i) => put(k, 'v' + (i + 10)));
      silent = false;
      S0();
      function S0() { msg = { t: 'Уже записано 8 значений: два файла в L0. Ключи user:1 и user:2 перезаписывались — их старые версии лежат в старых файлах.', c: 'okc' }; draw(); }
    }
  });

  /* ---------- 7. Token bucket ---------- */
  SD.LABS.push({
    id: 'bucket', title: 'Token bucket', lede: 'Лимит частоты в реальном времени', dive: 'ratelimit',
    intro: 'Ведро наполняется токенами со скоростью rate, но не выше ёмкости. Каждый запрос забирает токен, нет токена — 429. Ёмкость разрешает всплески, скорость задаёт средний лимит.',
    tasks: [{ id: 'burst', text: 'Настрой так, чтобы всплеск из 20 запросов прошёл целиком' }, { id: 'sustain', text: 'Пусти постоянный поток выше rate и посмотри на долю отказов' }, { id: 'fit', text: 'При потоке 15 запросов/с добейся отказов меньше 5 %' }],
    mount(el, api) {
      let cap = 10, rate = 5, rps = 0, tokens = 10, acc = 0, hist = [], ok = 0, rej = 0, winOk = 0, winRej = 0;
      const arrive = n => { let a = 0, r = 0; for (let i = 0; i < n; i++) { if (tokens >= 1) { tokens -= 1; a++; } else r++; } ok += a; rej += r; winOk += a; winRej += r; return { a, r }; };
      const draw = () => {
        const maxH = Math.max(4, ...hist.map(h => h.a + h.r));
        el.innerHTML = `<div class="lab-split"><svg viewBox="0 0 160 220" class="lab-svg" aria-label="Ведро токенов">
            <path d="M30 40 L40 200 L120 200 L130 40" fill="none" stroke="var(--border-strong)" stroke-width="3"></path>
            <rect x="${40}" y="${200 - 160 * tokens / cap}" width="80" height="${160 * tokens / cap}" fill="var(--accent-soft)" stroke="var(--accent)"></rect>
            <text x="80" y="30" text-anchor="middle" class="lab-big">${tokens.toFixed(1)} / ${cap}</text><text x="80" y="215" text-anchor="middle" class="lab-small">токенов</text></svg>
          <div class="lab-side">
            <div class="prop"><label for="tbC">Ёмкость <output>${cap}</output></label><input type="range" id="tbC" min="1" max="50" value="${cap}"></div>
            <div class="prop"><label for="tbR">Пополнение, токенов/с <output>${rate}</output></label><input type="range" id="tbR" min="1" max="40" value="${rate}"></div>
            <div class="prop"><label for="tbP">Постоянный поток, запросов/с <output>${rps}</output></label><input type="range" id="tbP" min="0" max="40" value="${rps}"></div>
            <div class="row-btns"><button type="button" class="btn" id="tb1">1 запрос</button><button type="button" class="btn primary" id="tb20">Всплеск ×20</button><button type="button" class="btn ghost" id="tbReset">Сбросить счёт</button></div>
            <p class="note">Пропущено ${ok}, отклонено 429: ${rej}${ok + rej ? ` (${Math.round(rej / (ok + rej) * 100)} %)` : ''}.</p>
            <svg viewBox="0 0 300 70" class="spark" aria-label="Пропущенные и отклонённые по времени">${hist.map((h, i) => `<rect x="${i * 5}" y="${66 - h.a / maxH * 60}" width="4" height="${h.a / maxH * 60}" fill="var(--ok)"></rect><rect x="${i * 5}" y="${66 - (h.a + h.r) / maxH * 60}" width="4" height="${h.r / maxH * 60}" fill="var(--bad)"></rect>`).join('')}</svg>
          </div></div>`;
        const bind = (id, f) => { el.querySelector(id).oninput = e => { f(+e.target.value); }; };
        bind('#tbC', v => { cap = v; tokens = Math.min(tokens, cap); }); bind('#tbR', v => { rate = v; }); bind('#tbP', v => { rps = v; winOk = 0; winRej = 0; });
        el.querySelector('#tb1').onclick = () => { arrive(1); };
        el.querySelector('#tb20').onclick = () => { const r = arrive(20); if (r.r === 0) api.done('burst'); };
        el.querySelector('#tbReset').onclick = () => { ok = rej = 0; winOk = winRej = 0; };
      };
      let tick = 0;
      const iv = setInterval(() => {
        if (document.hidden) return;
        tokens = Math.min(cap, tokens + rate * 0.1);
        acc += rps * 0.1; const n = Math.floor(acc); acc -= n;
        const r = arrive(n);
        hist.push(r); if (hist.length > 60) hist.shift();
        if (++tick % 3 === 0) {
          const tot = winOk + winRej;
          if (rps > rate + 2 && tot > 40 && winRej / tot > 0.1) api.done('sustain');
          if (rps >= 15 && tot > 60 && winRej / tot < 0.05) api.done('fit');
          const active = document.activeElement; if (!(active && active.type === 'range' && el.contains(active))) draw();
        }
      }, 100);
      draw();
      return () => clearInterval(iv);
    }
  });

  /* ---------- 8. Snowflake ID ---------- */
  SD.LABS.push({
    id: 'snowflake', title: 'Генератор ID: Snowflake', lede: 'Уникальные ID без координации', dive: 'ids',
    intro: '64 бита: 41 — миллисекунды от эпохи, 10 — номер машины, 12 — счётчик внутри миллисекунды. ID уникальны без общей базы и сортируются по времени. Попробуй переполнить счётчик и откатить часы.',
    tasks: [{ id: 'machines', text: 'Сгенерируй ID на трёх разных машинах' }, { id: 'overflow', text: 'Сгенерируй больше 4 096 ID за одну миллисекунду' }, { id: 'clock', text: 'Откати часы назад и посмотри, как генератор защищается' }],
    mount(el, api) {
      const EPOCH = Date.UTC(2020, 0, 1);
      let machine = 3, lastTs = -1, seq = 0, skew = 0, ids = [], machinesUsed = new Set(), msg = '';
      const now = () => Date.now() - EPOCH - skew;
      const gen = () => {
        let ts = now();
        if (ts < lastTs) { msg = { t: `Часы ушли назад на ${lastTs - ts} мс. Генератор не выдаёт ID, пока время не догонит последнее, иначе ID могли бы повториться.`, c: 'badc' }; api.done('clock'); return null; }
        if (ts === lastTs) { seq = (seq + 1) & 4095; if (seq === 0) { while (ts <= lastTs) ts = lastTs + 1; msg = { t: 'Счётчик переполнился (4 096 ID за миллисекунду): генератор ждёт следующую миллисекунду.', c: 'okc' }; api.done('overflow'); } }
        else seq = 0;
        lastTs = ts;
        return (BigInt(ts) << 22n) | (BigInt(machine) << 12n) | BigInt(seq);
      };
      const bin = id => id.toString(2).padStart(64, '0');
      const draw = () => {
        const last = ids[0];
        const b = last ? bin(last.id) : '0'.repeat(64);
        el.innerHTML = `<div class="lab-side wide">
          <div class="row-btns"><label class="lab-inline">Машина <input type="number" id="sfM" min="0" max="1023" value="${machine}" class="lab-input" style="width:90px"></label><button type="button" class="btn primary" id="sfGen">Сгенерировать</button><button type="button" class="btn" id="sfBurst">5 000 за раз</button><button type="button" class="btn ghost" id="sfSkew">${skew ? 'Вернуть часы' : 'Откатить часы на 5 мс'}</button></div>
          ${msg ? `<div class="lab-card ${msg.c}">${msg.t}</div>` : ''}
          <div class="sf-bits"><span class="sb0">${b[0]}</span><span class="sb1">${b.slice(1, 42)}</span><span class="sb2">${b.slice(42, 52)}</span><span class="sb3">${b.slice(52)}</span></div>
          <div class="sf-legend"><span class="sb1">время, 41 бит</span><span class="sb2">машина, 10 бит</span><span class="sb3">счётчик, 12 бит</span></div>
          ${last ? `<p class="note">ID ${last.id.toString()} · время ${new Date(Number(last.id >> 22n) + EPOCH).toISOString().slice(11, 23)} · машина ${Number((last.id >> 12n) & 1023n)} · счётчик ${Number(last.id & 4095n)}</p>` : ''}
          <ul class="lab-log">${ids.slice(0, 8).map(x => `<li>${x.id.toString()} <small>машина ${x.m}</small></li>`).join('')}</ul>
          <div class="lab-card"><b>Сравни.</b> Автоинкремент в одной базе — точка отказа и узкое место. UUIDv4 — 128 случайных бит: уникален без координации, но не сортируется и раздувает индекс. UUIDv7 и Snowflake кладут время в начало: ID растут, вставки в B-tree идут в конец.</div></div>`;
        el.querySelector('#sfM').onchange = e => { machine = Math.max(0, Math.min(1023, +e.target.value || 0)); };
        el.querySelector('#sfGen').onclick = () => { msg = ''; const id = gen(); if (id !== null) { ids.unshift({ id, m: machine }); machinesUsed.add(machine); if (machinesUsed.size >= 3) api.done('machines'); } draw(); };
        el.querySelector('#sfBurst').onclick = () => { msg = ''; let n = 0, start = now(); for (let i = 0; i < 5000; i++) { const id = gen(); if (id !== null) { n++; if (i === 4999) ids.unshift({ id, m: machine }); } } if (!msg) msg = { t: `5 000 ID за ${now() - start + 1} мс без повторов.`, c: 'okc' }; draw(); };
        el.querySelector('#sfSkew').onclick = () => { skew = skew ? 0 : 5; if (skew) { gen(); } draw(); };
      };
      draw();
    }
  });
})();
