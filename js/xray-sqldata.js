/* «Реляционная БД изнутри» → вид «Данные: партиции и шарды»: живая таблица users прямо в сцене базы,
   с шардами, ключом, партициями и репликами этого узла. Настройки узла меняются — таблица перекладывается. */
(function () {
  const def = SD.XRAY && SD.XRAY.sql; if (!def) return;
  const KEY = { hash: 'id', range: 'created_at', geo: 'country' }, PART = { none: 'none', month: 'range', hash: 'hash' };
  const optsOf = n => {
    const p = n.props || {};
    return { shards: Math.max(1, Math.min(4, p.shards || 1)), key: KEY[p.shardKey] || 'id', method: 'mod', partition: PART[p.partition] || 'none', replicas: Math.min(2, p.replicas || 0),
      idx: Array.isArray(p.idx) ? p.idx.slice() : (p.indexes === false ? [] : ['btree']), isolation: p.isolation || 'rc', locking: p.locking || 'none', size: p.size || 'm' };
  };
  /* виды сцены: механика базы и четыре взгляда на данные таблицы users */
  const TAB = { 'data-idx': 'idx', data: 'shard', 'data-iso': 'iso', 'data-srv': 'srv' };
  def.views = [
    { id: 'engine', name: 'Как работает внутри' },
    { id: 'data-idx', name: 'Индексы на данных', scenarios: [] },
    { id: 'data', name: 'Партиции и шарды', scenarios: [] },
    { id: 'data-iso', name: 'Изоляция', scenarios: [] },
    { id: 'data-srv', name: 'Сервер', scenarios: [] }
  ];
  const isData = v => !!TAB[v];
  const parts0 = def.parts, legend0 = def.legend;
  def.parts = v => isData(v) ? null : (typeof parts0 === 'function' ? parts0(v) : parts0);
  def.legend = v => isData(v) ? [] : (typeof legend0 === 'function' ? legend0(v) : legend0);
  const mount0 = def.mount;
  def.mount = ctx => {
    const inner = mount0(ctx) || {};
    let emb = null;
    const enter = (v) => {
      ctx.useHtml(true); box(true);
      ctx.html.innerHTML = '<p class="xsd-lede">Таблица <b>users</b> этой базы — 48 строк для наглядности. Индексы, уровень изоляции, блокировки, размер сервера, шарды, партиции и реплики — как у узла на площадке: поменяй их в настройках справа, и картинка перестроится. Вкладка «Запросы» показывает путь запроса к данным, а переключатель «Бизнес» — что это значит для магазина в секундах и рублях.</p><div class="xsd-wrap"></div>';
      const el = ctx.html.querySelector('.xsd-wrap');
      if (SD.labTable && SD.labTable.embed) emb = SD.labTable.embed(el, Object.assign(optsOf(ctx.node), { tab: TAB[v || ctx.view()] || 'shard' }));
      else {
        const lab = (SD.LABS || []).find(l => l.id === 'table');
        const off = lab ? lab.mount(el, { done: () => {} }) : null;
        emb = { set: () => {}, destroy: () => { if (typeof off === 'function') off(); } };
      }
    };
    const box = on => { ['xrStats', 'xrNow'].forEach(id => { const e = document.getElementById(id); if (e) e.hidden = on; }); };
    const leave = () => { if (emb) emb.destroy(); emb = null; ctx.html.innerHTML = ''; ctx.useHtml(false); box(false); };
    /* «Взгляд: Техника | Бизнес» — прямо в верхней панели сцены, видно сразу при входе */
    const MK = 'amp-stroyka-lt-mode';
    const mode = () => { try { return localStorage.getItem(MK) === 'biz' ? 'biz' : 'tech'; } catch (e) { return 'tech'; } };
    const ctl = document.getElementById('xrCtl');
    const inject = () => {
      if (!ctl || ctl.querySelector('.xsd-mode')) return;
      const g = document.createElement('div'); g.className = 'xr-grp xsd-mode';
      g.innerHTML = `<b>Взгляд</b><div class="seg"><button type="button" data-xsdmode="tech" aria-selected="${mode() === 'tech'}" title="Как устроено технически">Техника</button><button type="button" data-xsdmode="biz" aria-selected="${mode() === 'biz'}" title="Что это значит для бизнеса: секунды, заказы, рубли">Бизнес</button></div>`;
      const v = ctl.querySelector('.xr-views'); if (v && v.nextSibling) ctl.insertBefore(g, v.nextSibling); else ctl.appendChild(g);
    };
    const mo = ctl ? new MutationObserver(inject) : null; if (mo) mo.observe(ctl, { childList: true });
    const onMode = e => {
      const b = e.target.closest('[data-xsdmode]'); if (!b) return;
      const m = b.dataset.xsdmode;
      try { localStorage.setItem(MK, m); } catch (err) { /* без хранилища */ }
      ctl.querySelectorAll('[data-xsdmode]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.xsdmode === m)));
      if (!emb) { const dv = document.querySelector('[data-xview="data-idx"]'); if (dv) dv.click(); }
      else { const lb = ctx.html.querySelector(`.xsd-wrap [data-mode="${m}"]`); if (lb) lb.click(); }
    };
    if (ctl) ctl.addEventListener('click', onMode);
    setTimeout(inject, 0);
    if (isData(ctx.view())) enter(ctx.view());
    const sync = () => { if (emb && emb.set) emb.set(optsOf(ctx.node)); };
    return Object.assign({}, inner, {
      view(v) { if (isData(v)) { if (!emb) enter(v); else if (emb.set) emb.set({ tab: TAB[v] }); } else if (emb) leave(); if (inner.view) inner.view(v); },
      tick(dt) { if (!emb && inner.tick) inner.tick(dt); },
      draw() { if (!emb && inner.draw) inner.draw(); },
      onProp(k, v) { sync(); if (inner.onProp) inner.onProp(k, v); },
      refresh() { sync(); if (inner.refresh) inner.refresh(); },
      stats() { return emb ? [] : (inner.stats ? inner.stats() : []); },
      now() { return emb ? '' : (inner.now ? inner.now() : ''); },
      destroy() { leave(); if (mo) mo.disconnect(); if (ctl) { ctl.removeEventListener('click', onMode); const g = ctl.querySelector('.xsd-mode'); if (g) g.remove(); } if (inner.destroy) inner.destroy(); }
    });
  };
})();
