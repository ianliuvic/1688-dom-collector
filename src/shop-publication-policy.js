const YIPIN_DOMAIN = 'shop478x140nz9144.1688.com';
const YIPIN_ALLOWED_CATEGORIES = new Set(['沙滩防晒服', '沙滩裙、沙滩套装']);

function clean(value) {
  return String(value ?? '').trim();
}

export function evaluateShopProductPolicy(sourceListings = []) {
  const listings = Array.isArray(sourceListings) ? sourceListings : [];
  const targetRows = listings.filter((row) => clean(row.domain).toLowerCase() === YIPIN_DOMAIN);
  if (!targetRows.length) return { allowed: true, policy: null, reason: null };

  const categories = [...new Set(targetRows.map((row) => clean(row.category)).filter(Boolean))];
  const allowed = categories.some((category) => YIPIN_ALLOWED_CATEGORIES.has(category));
  return {
    allowed,
    policy: 'yipin_swim_coverups_only',
    reason: allowed ? null : 'source_category_is_not_swim_coverup',
    sourceCategories: categories,
    allowedCategories: [...YIPIN_ALLOWED_CATEGORIES],
  };
}

export function enforceShopProductPolicy(sourceListings = []) {
  const result = evaluateShopProductPolicy(sourceListings);
  if (!result.allowed) {
    const error = new Error('This shop is restricted to verified swimwear cover-up source categories.');
    error.code = 'shop_product_policy_rejected';
    error.policy = result;
    throw error;
  }
  return result;
}
