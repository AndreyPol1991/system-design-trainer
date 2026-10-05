/* «Изнутри» → виды «на данных»: живая таблица users прямо в сцене узла, с настройками этого узла.
   Реляционная БД: индексы, партиции и шарды, изоляция, сервер, реплики. Кэш: ключи, TTL, вытеснение, лавина.
   Настройки узла меняются — картинка перестраивается. «Взгляд: Техника | Бизнес» — в верхней панели сцены. */
(function () {
  const MK = 'amp-stroyka-lt-mode';
  const KEY = { hash: 'id', range: 'created_at', geo: 'country' }, PART = { none: 'none', month: 'range', hash: 'hash' };
  const CFG = {
    sql: {
      tab: { 'data-idx': 'idx', data: 'shard', 'data-iso': 'iso', 'data-srv': 'srv', 'data-repl': 'repl' },
      views: [['data-idx', 'Индексы на данных'], ['data', 'Партиции и шарды'], ['data-iso', 'Изоляция'], ['data-repl', 'Реплики'], ['data-srv', 'Сервер']],
      first: 'data-idx',
      lede: 'Таблица <b>users</b> этой базы — 48 строк для наглядности. Индексы, уровень изоляции, блокировки, размер сервера, шарды, партиции, реплики и режим репликации — как у узла на площадке: поменяй их в настройках справа, и картинка перестроится.',
      opts: p => ({ shards: Math.max(1, Math.min(4, p.shards || 1)), key: KEY[p.shardKey] || 'id', method: 'mod', partition: PART[p.partition] || 'none', replicas: Math.min(2, p.replicas || 0),
        idx: Array.isArray(p.idx) ? p.idx.slice() : (p.indexes === false ? [] : ['btree']), isolation: p.isolation || 'rc', locking: p.locking || 'none', size: p.size || 'm',
        replMode: p.replMode || 'async', ryw: !!p.ryw })
    },
    cache: {
      tab: { 'data-cache': 'cache' },
      views: [['data-cache', 'Кэш на данных']],
      first: 'data-cache',
      lede: 'Кэш перед таблицей <b>users</b>: ключи <code>user:ID</code>, срок жизни, вытеснение, стратегия записи и защита от лавины — как у узла на площадке. Поменяй настройки справа — поведение изменится.',
      opts: p => ({ cacheMem: p.mem || 32, cacheNodes: p.count || 1, ttl: p.ttl || '10m', eviction: p.eviction || 'lru', policy: p.policy || 'aside', invalidate: p.invalidate !== false, stampede: p.stampede || false })
    }
  };
  function attach(type, C) {
    const def = SD.XRAY && SD.XRAY[type]; if (!def) return;
    const views0 = def.views;
    def.views = (views0 && views0.length ? views0 : [{ id: 'engine', name: 'Как работает внутри' }]).concat(C.views.map(([id, name]) => ({ id, name, scenarios: [] })));
    const isData = v => !!C.tab[v];
    const parts0 = def.parts, legend0 = def.legend;
    def.parts = v => isData(v) ? null : (typeof parts0 === 'function' ? parts0(v) : parts0);
    def.legend = v => isData(v) ? [] : (typeof legend0 === 'function' ? legend0(v) : legend0);
    const mount0 = def.mount;
    def.mount = ctx => {
      const inner = mount0(ctx) || {};
      let emb = null;
      const box = on => { ['xrStats', 'xrNow'].forEach(id => { const e = document.getElementById(id); if (e) e.hidden = on; }); };
      const enter = v => {
        ctx.useHtml(true); box(true);
        ctx.html.innerHTML = `<p class="xsd-lede">${C.lede} Переключатель «Бизнес» вверху — что это значит для магазина в секундах и рублях.</p><div class="xsd-wrap"></div>`;
        const el = ctx.html.querySelector('.xsd-wrap');
        if (SD.labTable && SD.labTable.embed) emb = SD.labTable.embed(el, Object.assign(C.opts(ctx.node.props || {}), { tab: C.tab[v || ctx.view()] }));
        else emb = { set: () => {}, destroy: () => {} };
      };
      const leave = () => { if (emb) emb.destroy(); emb = null; ctx.html.innerHTML = ''; ctx.useHtml(false); box(false); };
      const mode = () => { try { return localStorage.getItem(MK) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
      const ctl = document.getElementById('xrCtl');
      const inject = () => {
        if (!ctl || ctl.querySelector('.xsd-mode')) return;
        const g = document.createElement('div'); g.className = 'xr-grp xsd-mode';
        g.innerHTML = `<b>Взгляд</b><div class="seg"><button type="button" data-xsdmode="tech" aria-selected="${mode() === 'tech'}" title="Как устроено технически">Техника</button><button type="button" data-xsdmode="biz" aria-selected="${mode() === 'biz'}" title="Что это значит для бизнеса: секунды, заказы, рубли">Бизнес</button></div>`;
        const vv = ctl.querySelector('.xr-views'); if (vv && vv.nextSibling) ctl.insertBefore(g, vv.nextSibling); else ctl.appendChild(g);
      };
      const mo = ctl ? new MutationObserver(inject) : null; if (mo) mo.observe(ctl, { childList: true });
      const onMode = e => {
        const b = e.target.closest('[data-xsdmode]'); if (!b) return;
        const m = b.dataset.xsdmode;
        try { localStorage.setItem(MK, m); } catch (err) { /* без хранилища */ }
        ctl.querySelectorAll('[data-xsdmode]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.xsdmode === m)));
        if (!emb) { const dv = document.querySelector(`[data-xview="${C.first}"]`); if (dv) dv.click(); }
        else { const lb = ctx.html.querySelector(`.xsd-wrap [data-mode="${m}"]`); if (lb) lb.click(); }
      };
      if (ctl) ctl.addEventListener('click', onMode);
      setTimeout(inject, 0);
      if (isData(ctx.view())) enter(ctx.view());
      const sync = () => { if (emb && emb.set) emb.set(C.opts(ctx.node.props || {})); };
      return Object.assign({}, inner, {
        view(v) { if (isData(v)) { if (!emb) enter(v); else if (emb.set) emb.set({ tab: C.tab[v] }); } else if (emb) leave(); if (inner.view) inner.view(v); },
        tick(dt) { if (!emb && inner.tick) inner.tick(dt); },
        draw() { if (!emb && inner.draw) inner.draw(); },
        onProp(k, v) { sync(); if (inner.onProp) inner.onProp(k, v); },
        refresh() { sync(); if (inner.refresh) inner.refresh(); },
        stats() { return emb ? [] : (inner.stats ? inner.stats() : []); },
        now() { return emb ? '' : (inner.now ? inner.now() : ''); },
        destroy() { leave(); if (mo) mo.disconnect(); if (ctl) { ctl.removeEventListener('click', onMode); const g = ctl.querySelector('.xsd-mode'); if (g) g.remove(); } if (inner.destroy) inner.destroy(); }
      });
    };
  }
  Object.entries(CFG).forEach(([t, c]) => attach(t, c));
})();
