const SIZE_ORDER = new Map([
  ['XXXXS', 0], ['XXXS', 1], ['XXS', 2], ['XS', 3], ['S', 4], ['M', 5], ['L', 6],
  ['XL', 7], ['XXL', 8], ['XXXL', 9], ['XXXXL', 10], ['XXXXXL', 11],
]);
const SIZE_LABELS = new Map([...SIZE_ORDER].map(([label, rank]) => [rank, label]));

function clean(value) {
  return String(value ?? '').replace(/\s+/g, '').trim().toUpperCase();
}

function rank(value) {
  const normalized = clean(value);
  const numberedXl = normalized.match(/^([2-5])XL$/);
  if (numberedXl) return SIZE_ORDER.get(`${'X'.repeat(Number(numberedXl[1]))}L`) ?? null;
  if (SIZE_ORDER.has(normalized)) return SIZE_ORDER.get(normalized);
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return 100 + Number(normalized);
  return null;
}

/**
 * Deterministic size-list audit used by Selection and the product-catalog add flow.
 * Unknown/kids sizes are intentionally skipped instead of producing false alarms.
 */
export function auditSizeValues(values) {
  const raw = (Array.isArray(values) ? values : []).map(clean).filter(Boolean);
  if (raw.length < 2) return null;
  const duplicate = [...new Set(raw.filter((value, index) => raw.indexOf(value) !== index))];
  if (duplicate.length) return { code: 'duplicate_sizes', message: `重复尺码：${duplicate.join('、')}`, values: raw };
  const ranks = raw.map(rank);
  if (ranks.some((value) => value === null)) return null;
  const sorted = [...raw].sort((left, right) => rank(left) - rank(right));
  if (raw.join('|') !== sorted.join('|')) {
    return { code: 'size_order_unusual', message: `尺码顺序异常：当前 ${raw.join('、')}；建议 ${sorted.join('、')}`, values: raw, expected: sorted };
  }
  const alphaOnly = raw.every((value) => SIZE_ORDER.has(value));
  const numericOnly = raw.every((value) => /^\d+(?:\.\d+)?$/.test(value));
  if (!alphaOnly && !numericOnly) return null;
  const present = new Set(ranks);
  const missing = [];
  for (let value = Math.min(...ranks) + 1; value < Math.max(...ranks); value += 1) {
    if (present.has(value)) continue;
    missing.push(alphaOnly ? (SIZE_LABELS.get(value) ?? String(value)) : String(value));
  }
  if (!missing.length) return null;
  return { code: 'missing_size', message: `断码：缺少 ${missing.join('、')}；当前 ${raw.join('、')}`, values: raw, missing };
}

/** Extract the size dimension from the Products-page `dims` payload. */
export function sizeValuesFromDimensions(dimensions) {
  const sizeDimension = (Array.isArray(dimensions) ? dimensions : [])
    .find((dimension) => /(size|尺码|尺寸|码数)/i.test(String(dimension?.name ?? '')));
  const values = Array.isArray(sizeDimension?.values) ? sizeDimension.values
    : (Array.isArray(sizeDimension?.options) ? sizeDimension.options : []);
  return values
    .map((value) => typeof value === 'string' ? value : value?.text)
    .filter(Boolean);
}
