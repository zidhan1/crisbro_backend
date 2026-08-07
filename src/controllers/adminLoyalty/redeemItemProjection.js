const REDEEM_ITEM_SELECT = Object.freeze({
  id: true,
  menu_item_id: true,
  category_id: true,
  points_required: true,
  is_active: true,
  badge: true,
  sort_order: true,
  start_at: true,
  end_at: true,
  stock_limit: true,
  daily_limit: true,
  created_at: true,
  updated_at: true,
  category: {
    select: {
      id: true,
      name: true,
      sort_order: true,
      is_active: true,
      created_at: true,
      updated_at: true,
    },
  },
  menu_item: {
    include: { category: { select: { id: true, name: true } } },
  },
});

const REDEEM_ITEM_AUDIT_INCLUDE = Object.freeze({
  category: true,
  menu_item: { include: { category: true } },
});

module.exports = { REDEEM_ITEM_SELECT, REDEEM_ITEM_AUDIT_INCLUDE };
