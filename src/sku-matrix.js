// Shared builder for complete SKU rows from the 1688 embedded SKU model.
//
// The rendered expand rows only cover the currently selected option, which is
// why multi-colour listings used to lose their colour dimension. The embedded
// model (`window.context` skuModel, captured as raw_data.skuMatrix) lists
// every option x size combination with its own price and stock; this module
// turns it into the canonical SKU rows used by product_detail_skus and the
// WordPress payload.

const MAX_SKU_ROWS = 500;

export function normalizeMatrixDimensionName(value) {
  const name = String(value ?? '').trim();
  if (/^(?:颜色|color)$/i.test(name)) return 'Color';
  if (/^(?:尺码|尺寸|码数|size)$/i.test(name)) return 'Size';
  return name;
}

export function buildSkuRowsFromSkuModel(model) {
  const rows = [];
  for (const row of (Array.isArray(model?.rows) ? model.rows : []).slice(0, MAX_SKU_ROWS)) {
    const options = {};
    for (const [name, value] of Object.entries(row?.options ?? {})) {
      const cleanName = normalizeMatrixDimensionName(name);
      const cleanValue = String(value ?? '').replace(/\s+/g, ' ').trim();
      if (cleanName && cleanValue) options[cleanName] = cleanValue;
    }
    const entries = Object.entries(options);
    if (!entries.length) continue;
    const sizeEntry = entries.find(([name]) => name === 'Size');
    const colorEntry = entries.find(([name]) => name === 'Color');
    const skuText = sizeEntry ? sizeEntry[1] : (colorEntry ? colorEntry[1] : entries.map(([, value]) => value).join(' '));
    rows.push({
      skuKey: entries.map(([name, value]) => `${name}:${value}`).join('|'),
      skuText,
      options,
      price: row?.price != null && row.price !== '' && Number.isFinite(Number(row.price)) ? Number(row.price) : null,
      stock: row?.stock != null && row.stock !== '' && Number.isFinite(Number(row.stock)) ? Number(row.stock) : null,
    });
  }
  return rows;
}
