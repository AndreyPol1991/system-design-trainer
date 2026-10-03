/* Роли сервисов и готовые сервисы для палитры: «Сервис уведомлений», «Сервис платежей» и т. д. */
(function () {
  SD.ROLES = [['', 'Без роли'], ['orders', 'Заказы'], ['payments', 'Платежи'], ['notify', 'Уведомления'], ['catalog', 'Каталог'], ['users', 'Пользователи'], ['auth', 'Авторизация'], ['search', 'Поиск'], ['delivery', 'Доставка'], ['inventory', 'Склад'], ['analytics', 'Аналитика'], ['recs', 'Рекомендации'], ['bff', 'BFF для фронтенда']];
  SD.ROLE_LABEL = { orders: 'Сервис заказов', payments: 'Сервис платежей', notify: 'Сервис уведомлений', catalog: 'Сервис каталога', users: 'Сервис пользователей', auth: 'Сервис авторизации', search: 'Сервис поиска', delivery: 'Сервис доставки', inventory: 'Сервис склада', analytics: 'Сервис аналитики', recs: 'Сервис рекомендаций', bff: 'BFF' };
  const roleProp = { key: 'role', label: 'Роль сервиса', type: 'select', def: '', options: SD.ROLES, help: 'За что отвечает сервис. Название на схеме подставится само — его можно поменять в поле сверху.' };
  ['app', 'worker'].forEach(t => { if (SD.TYPES[t] && !SD.TYPES[t].props.some(p => p.key === 'role')) SD.TYPES[t].props.unshift(roleProp); });
  SD.PROP_SIMPLE = SD.PROP_SIMPLE || {};
  ['app', 'worker'].forEach(t => { SD.PROP_SIMPLE[t] = SD.PROP_SIMPLE[t] || {}; SD.PROP_SIMPLE[t].role = 'За какую часть бизнеса отвечает сервис: заказы, платежи, уведомления. Один сервис — одна область. Роль видна на схеме и в проверках архитектуры: например, «у каждого сервиса своя база» или «уведомления получают события из брокера».'; });

  /* готовые сервисы: тип узла, название, роль и типичные настройки */
  SD.SERVICE_PRESETS = [
    { id: 'orders', type: 'app', short: 'оформление и статусы', props: { role: 'orders', count: 2 } },
    { id: 'payments', type: 'app', short: 'оплата и возвраты', props: { role: 'payments', count: 2 } },
    { id: 'notify', type: 'worker', short: 'письма, SMS, push из очереди', props: { role: 'notify', count: 2 } },
    { id: 'catalog', type: 'app', short: 'товары и цены', props: { role: 'catalog', count: 2 } },
    { id: 'users', type: 'app', short: 'профили и настройки', props: { role: 'users', count: 2 } },
    { id: 'auth', type: 'app', short: 'вход и токены', props: { role: 'auth', count: 2 } },
    { id: 'search', type: 'app', short: 'поиск по каталогу', props: { role: 'search', count: 2 } },
    { id: 'delivery', type: 'app', short: 'доставка и трекинг', props: { role: 'delivery', count: 2 } },
    { id: 'inventory', type: 'app', short: 'остатки и резервы', props: { role: 'inventory', count: 2 } },
    { id: 'recs', type: 'app', short: 'рекомендации товаров', props: { role: 'recs', count: 2 } },
    { id: 'analytics', type: 'worker', short: 'события в аналитику', props: { role: 'analytics', count: 2 } }
  ];
  SD.SERVICE_PRESETS.forEach(p => { p.label = SD.ROLE_LABEL[p.props.role]; });
  /* когда меняется роль, меняется и название — если его не придумали вручную */
  SD.applyRole = (n, role, prev) => {
    const auto = !n.label || n.label === SD.TYPES[n.type].name || Object.values(SD.ROLE_LABEL).includes(n.label) || (prev && n.label === SD.ROLE_LABEL[prev]);
    if (auto) n.label = role ? SD.ROLE_LABEL[role] : undefined;
  };
})();
