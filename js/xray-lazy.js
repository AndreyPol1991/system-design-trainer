/* Сцены «изнутри» грузятся по требованию — при первом открытии узла (js/xray.js: need). Сцены — около 40 % всего кода,
   без них страница стартует заметно быстрее. Новая сцена: файл js/xray-<тип>.js и строка здесь. */
(function () {
  const L = SD.XRAY_LAZY = SD.XRAY_LAZY || {};
  const add = (file, types) => types.forEach(t => { L[t] = 'js/' + file; });
  add('xray-lb.js', ['lb']);
  add('xray-app.js', ['app']);
  add('xray-sql.js', ['sql']);
  add('xray-cache.js', ['cache']);
  add('xray-queue.js', ['queue', 'worker']);
  add('xray-olap.js', ['olap']);
  add('xray-lake.js', ['lake']);
  add('xray-etl.js', ['etl']);
  add('xray-nosql.js', ['nosql']);
  add('xray-objstore.js', ['objstore']);
  add('xray-cdn.js', ['cdn']);
  add('xray-search.js', ['search']);
  add('xray-gateway.js', ['gateway']);
  add('xray-ws.js', ['ws']);
  add('xray-llm.js', ['llm']);
  add('xray-vectordb.js', ['vectordb']);
  add('xray-agent.js', ['agent']);
  add('xray-router.js', ['router']);
  add('xray-semcache.js', ['semcache']);
  add('xray-guard.js', ['guard']);
})();
