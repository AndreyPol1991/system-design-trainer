/* «Реляционная БД изнутри» → вид «Данные: партиции и шарды»: живая таблица users прямо в сцене базы,
   с шардами, ключом, партициями и репликами этого узла. Настройки узла меняются — таблица перекладывается. */
(function () {
  const def = SD.XRAY && SD.XRAY.sql; if (!def) return;
  const KEY = { hash: 'id', range: 'created_at', geo: 'country' }, PART = { none: 'none', month: 'range', hash: 'hash' };
  const optsOf = n => {
    const p = n.props || {};
    return { shards: Math.max(1, Math.min(4, p.shards || 1)), key: KEY[p.shardKey] || 'id', method: 'mod', partition: PART[p.partition] || 'none', replicas: Math.min(2, p.replicas || 0) };
  };
  def.views = [
    { id: 'engine', name: 'Как работает внутри' },
    { id: 'data', name: 'Данные: партиции и шарды', scenarios: [] }
  ];
  const parts0 = def.parts, legend0 = def.legend;
  def.parts = v => v === 'data' ? null : (typeof parts0 === 'function' ? parts0(v) : parts0);
  def.legend = v => v === 'data' ? [] : (typeof legend0 === 'function' ? legend0(v) : legend0);
  const mount0 = def.mount;
  def.mount = ctx => {
    const inner = mount0(ctx) || {};
    let emb = null;
    const enter = () => {
      ctx.useHtml(true); box(true);
      ctx.html.innerHTML = '<p class="xsd-lede">Таблица <b>users</b> этой базы — 48 строк для наглядности. Шарды, ключ шардирования, партиции и реплики — как у узла на площадке: поменяй их в настройках справа, и строки переложатся. Вкладка «Запросы» показывает путь запроса к данным, а переключатель «Бизнес» — что это значит для магазина в секундах и рублях.</p><div class="xsd-wrap"></div>';
      const el = ctx.html.querySelector('.xsd-wrap');
      if (SD.labTable && SD.labTable.embed) emb = SD.labTable.embed(el, Object.assign(optsOf(ctx.node), { tab: 'shard' }));
      else {
        const lab = (SD.LABS || []).find(l => l.id === 'table');
        const off = lab ? lab.mount(el, { done: () => {} }) : null;
        emb = { set: () => {}, destroy: () => { if (typeof off === 'function') off(); } };
      }
    };
    const box = on => { ['xrStats', 'xrNow'].forEach(id => { const e = document.getElementById(id); if (e) e.hidden = on; }); };
    const leave = () => { if (emb) emb.destroy(); emb = null; ctx.html.innerHTML = ''; ctx.useHtml(false); box(false); };
    if (ctx.view() === 'data') enter();
    const sync = () => { if (emb && emb.set) emb.set(optsOf(ctx.node)); };
    return Object.assign({}, inner, {
      view(v) { if (v === 'data' && !emb) enter(); else if (v !== 'data' && emb) leave(); if (inner.view) inner.view(v); },
      tick(dt) { if (!emb && inner.tick) inner.tick(dt); },
      draw() { if (!emb && inner.draw) inner.draw(); },
      onProp(k, v) { sync(); if (inner.onProp) inner.onProp(k, v); },
      refresh() { sync(); if (inner.refresh) inner.refresh(); },
      stats() { return emb ? [] : (inner.stats ? inner.stats() : []); },
      now() { return emb ? '' : (inner.now ? inner.now() : ''); },
      destroy() { leave(); if (inner.destroy) inner.destroy(); }
    });
  };
})();
