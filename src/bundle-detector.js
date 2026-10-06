// Deterministic bundle detector for captured 1688 product details.
//
// A listing is treated as a "bundle" when a non-size option dimension mixes
// different garments (option names compared after stripping model codes and
// colour/print words), or when some options are one-size while others are
// sized. Per-item prices, stocks and sizes come from the embedded skuMatrix
// that the parser now captures from the live page; when the matrix is absent
// the name rule still applies and the split page can refresh live data.

export const SKU_SIZE_NAME_RE = /(尺码|尺寸|码数|size)/i;
const ONE_SIZE_RE = /(均码|one\s*size|free\s*size)/i;
const COLOR_WORDS = /(白色|白底|米白|奶白|黑色|红色|黄色|绿色|蓝色|粉色|橘色|橙色|咖色|棕色|紫色|灰色|浅蓝|深蓝|浅绿|深绿|银色|金色|彩色|花色|纯色|拼色|条纹|格子|格纹|豹纹|波点|碎花|印花|蕾丝|渐变|牛仔|晕染|扎染|民族风|腰果花|腰果|烫钻|珍珠|亮片|流苏|网纱|雪纺|假两件|钻带|酒红|玫红|藏青|墨绿|卡其|荧光|银|金|白|黑|红|黄|绿|蓝|粉|橘|橙|咖|棕|紫|灰)/g;
// Colour expressions like 酒红色/浅蓝色/黑色/橄榄绿: a short modifier chain in
// front of a colour character (with or without 色) is a colour, not a garment.
const COLOR_EXPRESSION_RE = /[\u4e00-\u9fa5]{0,2}(?:红|绿|蓝|黄|紫|灰|黑|白|棕|咖|橙|橘|粉|银|金|青|米|彩)色?/g;
const ENGLISH_COLOR_WORDS = /\b(?:beige|black|blue|brown|burgundy|coffee|cream|cyan|gold|gray|grey|green|khaki|lavender|magenta|maroon|mint|navy|olive|orange|peach|pink|purple|red|rose|silver|teal|violet|white|wine|yellow)\b/gi;
// Seller chatter that is not a product item either.
const JUNK_WORDS = /(现货|放心拍|包邮|新款|爆款|热卖|厂家直销|一件代发|支持混批|可定制|点击|咨询|客服|专拍|促销|特价)/g;

export function bundleItemKey(text) {
  let value = String(text || '');
  value = value.replace(/[A-Za-z]{1,6}[-_]?\d{2,}[A-Za-z0-9-]*/g, ' ');
  value = value.replace(/\d+(?:\.\d+)?/g, ' ');
  value = value.replace(COLOR_EXPRESSION_RE, ' ');
  value = value.replace(COLOR_WORDS, ' ');
  value = value.replace(ENGLISH_COLOR_WORDS, ' ');
  value = value.replace(JUNK_WORDS, ' ');
  value = value.replace(ONE_SIZE_RE, ' ');
  value = value.replace(/[\s\-_/、,，+!！?？~～·.。()（）[\]【】]+/g, '');
  return value;
}

export function detectBundle(data = {}) {
  const options = Array.isArray(data.skuOptions) ? data.skuOptions : [];
  const matrix = data.skuMatrix && Array.isArray(data.skuMatrix.rows) ? data.skuMatrix : null;
  const dimensions = Array.isArray(data.skuDimensions) ? data.skuDimensions : [];
  const items = new Map();
  for (const option of options) {
    const dimension = String(option?.dimensionName || '').trim();
    if (!dimension || SKU_SIZE_NAME_RE.test(dimension)) continue;
    const text = String(option?.text || '').trim();
    if (!text) continue;
    // Opaque labels (bare model codes with no garment noun) cannot prove that
    // options are different products, so they all collapse into one bucket
    // instead of counting as separate items.
    const key = bundleItemKey(text) || '(code)';
    if (!items.has(key)) items.set(key, { key, options: [], images: [], sizes: new Set(), prices: [], stocks: [] });
    const item = items.get(key);
    item.options.push(text);
    if (option?.image) item.images.push(String(option.image));
  }
  if (matrix) {
    for (const item of items.values()) {
      for (const row of matrix.rows) {
        const values = Object.values(row?.options || {});
        if (!item.options.some((text) => values.includes(text))) continue;
        const sizeValues = Object.entries(row.options || {})
          .filter(([name]) => SKU_SIZE_NAME_RE.test(name)).map(([, value]) => String(value));
        const fallback = values.filter((value) => !item.options.includes(value)).map((value) => String(value));
        (sizeValues.length ? sizeValues : fallback).forEach((value) => item.sizes.add(value));
        if (Number.isFinite(Number(row.price))) item.prices.push(Number(row.price));
        if (Number.isFinite(Number(row.stock))) item.stocks.push(Number(row.stock));
      }
    }
  }
  const itemList = [...items.values()].map((item) => ({
    key: item.key,
    options: item.options,
    images: [...new Set(item.images)].slice(0, 20),
    sizes: [...item.sizes],
    price: item.prices.length ? Math.max(...item.prices) : null,
    stock: item.stocks.length ? item.stocks.reduce((sum, value) => sum + value, 0) : null,
  }));
  const nameMixing = itemList.length >= 2;
  const oneSizeItems = itemList.filter((item) => item.sizes.length && item.sizes.every((size) => ONE_SIZE_RE.test(size)));
  const sizedItems = itemList.filter((item) => item.sizes.some((size) => !ONE_SIZE_RE.test(size)));
  const sizeConflict = oneSizeItems.length > 0 && sizedItems.length > 0;
  const status = nameMixing || sizeConflict ? 'bundle' : 'clear';
  return {
    status,
    analysis: {
      detectedAt: new Date().toISOString(),
      rules: { nameMixing, sizeConflict },
      itemCount: itemList.length,
      items: itemList,
      optionCount: options.length,
      dimensions: dimensions.map((dimension) => ({
        name: String(dimension?.name || '').trim(),
        values: Array.isArray(dimension?.values) ? dimension.values.map((value) => String(value)) : [],
      })).filter((dimension) => dimension.name),
      priceScale: matrix?.priceScale || null,
      matrixRows: matrix ? matrix.rows.length : 0,
    },
  };
}
