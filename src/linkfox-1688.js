// LinkFox 1688 product-detail source branch.
//
// Fetches the standardized LinkFox product record for one 1688 offer, maps it
// into the collector's canonical product shape (title/description/images/
// skuOptions/skuDimensions/skuRows/attributes/price/package/seller metrics)
// and downloads every media image (main/gallery/swatch/description) into the
// collector's persistent storage. Videos are intentionally not downloaded.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_GATEWAY = 'https://tool-gateway.linkfox.com';
const MAX_IMAGES = 400;

function text(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalOptionKey(attributeNameTrans, attributeName) {
  const en = text(attributeNameTrans).toLowerCase();
  if (en === 'color' || en === 'colour') return 'Color';
  if (en === 'size') return 'Size';
  const cn = text(attributeName);
  if (/^颜色$/.test(cn)) return 'Color';
  if (/^(尺码|尺寸|码数)$/.test(cn)) return 'Size';
  return text(attributeNameTrans) || cn || 'Option';
}

function parseDescriptionImages(html) {
  const urls = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const raw = text(match[1]);
    if (!raw) continue;
    const url = raw.startsWith('//') ? `https:${raw}` : raw;
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function linkfoxEndpoint(gateway) {
  const base = String(gateway || DEFAULT_GATEWAY).replace(/\/+$/, '');
  return `${base}/alibaba1688/productDetail`;
}

/** Fetch one 1688 product record through the LinkFox gateway. */
export async function fetchLinkFoxProductDetail({ offerId }, config = {}) {
  const apiKey = String(config?.linkfoxApiKey || '').trim();
  if (!apiKey) throw new Error('LINKFOX_API_KEY is not configured.');
  const response = await fetch(linkfoxEndpoint(config.linkfoxGateway), {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
      'user-agent': 'LinkFox-Skill/2.0',
    },
    body: JSON.stringify({ offerId: String(offerId) }),
    signal: AbortSignal.timeout(150000),
  });
  const rawText = await response.text();
  let body = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = null;
  }
  if ([401, 402, 403].includes(response.status)) {
    const error = new Error(`LinkFox access blocked (HTTP ${response.status}).`);
    error.providerAccess = true;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(String(body?.errmsg || body?.message || `LinkFox HTTP ${response.status}`));
    error.status = response.status;
    throw error;
  }
  if (!body) throw new Error('LinkFox returned an empty response.');
  if (body.errcode && Number(body.errcode) !== 200) {
    const error = new Error(String(body.errmsg || 'LinkFox returned an error.'));
    error.status = 502;
    throw error;
  }
  if (String(body.offerId ?? '') !== String(offerId)) {
    throw new Error('LinkFox response offerId mismatch.');
  }
  return body;
}

/** Normalize the LinkFox response into the collector product shape plus an image download plan. */
export function buildLinkFoxCapture(raw, { offerId, offerKey }) {
  const skuList = Array.isArray(raw.skuList) ? raw.skuList : [];
  const dimensionOrder = [];
  const dimensionValues = new Map();
  const optionsByKey = new Map();
  const skuRows = [];

  for (const sku of skuList) {
    const attributes = Array.isArray(sku.attributes) ? sku.attributes : [];
    const options = {};
    const entries = [];
    for (const attribute of attributes) {
      const dimensionName = text(attribute.attributeName) || text(attribute.attributeNameTrans);
      const value = text(attribute.value);
      if (!dimensionName || !value) continue;
      const key = canonicalOptionKey(attribute.attributeNameTrans, attribute.attributeName);
      options[key] = value;
      entries.push([key, value]);
      if (!dimensionValues.has(dimensionName)) {
        dimensionValues.set(dimensionName, new Set());
        dimensionOrder.push(dimensionName);
      }
      dimensionValues.get(dimensionName).add(value);
      const optionKey = `${dimensionName}\u0001${value}`;
      if (!optionsByKey.has(optionKey)) {
        // Only colour-style attributes may fall back to the SKU-level image;
        // size options must not inherit a swatch from their colour sibling.
        const optionImage = text(attribute.skuImageUrl)
          || (key === 'Color' ? text(sku.skuImageUrl) : '');
        optionsByKey.set(optionKey, {
          dimensionName,
          text: value,
          image: optionImage || null,
        });
      }
    }
    if (!entries.length) continue;
    const sizeEntry = entries.find(([key]) => key === 'Size');
    const colorEntry = entries.find(([key]) => key === 'Color');
    const skuText = sizeEntry ? sizeEntry[1] : (colorEntry ? colorEntry[1] : entries.map(([, value]) => value).join(' '));
    skuRows.push({
      skuKey: entries.map(([key, value]) => `${key}:${value}`).join('|'),
      skuText,
      options,
      price: numberOrNull(sku.price) ?? numberOrNull(sku.retailPrice),
      stock: numberOrNull(sku.amountOnSale),
      skuId: text(sku.skuId) || null,
      retailPrice: numberOrNull(sku.retailPrice),
      foreignCurrencyRetailPrice: numberOrNull(sku.foreignCurrencyRetailPrice),
      promotionPrice: numberOrNull(sku.promotionPrice),
      consignPrice: numberOrNull(sku.consignPrice),
      fenxiaoPriceInfo: sku.fenxiaoPriceInfo ?? null,
      specId: text(sku.specId) || null,
      cargoNumber: text(sku.cargoNumber) || null,
      skuImageUrl: text(sku.skuImageUrl) || null,
    });
  }

  const skuDimensions = dimensionOrder.map((name) => ({ name, values: [...dimensionValues.get(name)] }));
  const skuOptions = [...optionsByKey.values()];
  const productImages = (Array.isArray(raw.productImage?.images) ? raw.productImage.images : [])
    .map(text).filter(Boolean);
  const whiteImage = text(raw.productImage?.whiteImage);
  const descriptionImages = parseDescriptionImages(raw.description);

  const imagePlan = [];
  const pushImage = (url, type, sortOrder, label) => {
    if (!url) return;
    imagePlan.push({ url, type, sortOrder, label: label ?? null });
  };
  productImages.forEach((url, index) => pushImage(url, index === 0 ? 'main' : 'gallery',
    index === 0 ? 0 : index, `main set ${index + 1}`));
  if (whiteImage) pushImage(whiteImage, 'gallery', productImages.length + 1, 'white image');
  skuOptions.forEach((option, index) => pushImage(option.image, 'sku', index, option.text));
  descriptionImages.forEach((url, index) => pushImage(url, 'description', index, `description ${index + 1}`));

  const priceCandidates = [];
  for (const row of skuRows) {
    for (const value of [row.price, row.retailPrice]) {
      if (value !== null && value >= 0) priceCandidates.push(value);
    }
  }
  const tiers = (Array.isArray(raw.saleInfo?.priceRanges) ? raw.saleInfo.priceRanges : []).map((tier) => ({
    minQuantity: numberOrNull(tier.startQuantity),
    maxQuantity: null,
    price: numberOrNull(tier.price),
    promotionPrice: numberOrNull(tier.promotionPrice),
    foreignCurrencyPrice: numberOrNull(tier.foreignCurrencyPrice),
  })).filter((tier) => tier.minQuantity !== null && tier.price !== null);
  for (const tier of tiers) priceCandidates.push(tier.price);
  const verifiedPrices = priceCandidates.filter((value) => Number.isFinite(value));
  const price = {
    min: verifiedPrices.length ? Math.min(...verifiedPrices) : null,
    max: verifiedPrices.length ? Math.max(...verifiedPrices) : null,
    tiers,
    source: 'linkfox_sku_and_price_ranges',
    verified: verifiedPrices.length > 0,
    textCandidates: [],
  };

  const attributes = (Array.isArray(raw.productAttributes) ? raw.productAttributes : [])
    .map((attribute) => ({
      name: text(attribute.attributeName),
      value: text(attribute.value),
      nameTrans: text(attribute.attributeNameTrans) || null,
      valueTrans: text(attribute.valueTrans) || null,
      attributeId: text(attribute.attributeId) || null,
    }))
    .filter((attribute) => attribute.name && attribute.value)
    .slice(0, 200);

  const shipping = raw.shippingInfo && typeof raw.shippingInfo === 'object' ? raw.shippingInfo : null;
  const linkfoxExtra = {
    retailPrice: numberOrNull(raw.saleInfo?.retailPrice),
    foreignCurrencyRetailPrice: numberOrNull(raw.saleInfo?.foreignCurrencyRetailPrice),
    quoteType: numberOrNull(raw.saleInfo?.quoteType),
    unitInfo: raw.saleInfo?.unitInfo ?? null,
    fenxiaoSaleInfo: raw.saleInfo?.fenxiaoSaleInfo ?? null,
    promotion: raw.promotion ?? null,
    invoiceInfo: raw.invoiceInfo ?? null,
    certificates: raw.certificates ?? [],
    sellerMixSetting: raw.sellerMixSetting ?? null,
    tags: raw.tags ?? [],
    sellingPoints: raw.sellingPoints ?? [],
    offerIdentities: raw.offerIdentities ?? [],
    categoryId: text(raw.categoryId) || null,
    topCategoryId: text(raw.topCategoryId) || null,
    secondCategoryId: text(raw.secondCategoryId) || null,
    thirdCategoryId: text(raw.thirdCategoryId) || null,
    categoryName: text(raw.categoryName) || null,
    tradeScore: text(raw.tradeScore) || null,
    soldOut: text(raw.soldOut) || null,
    batchNumber: numberOrNull(raw.batchNumber),
    isJxhy: raw.isJxhy === true,
    isSelect: raw.isSelect === true,
    createDate: text(raw.createDate) || null,
    subjectTrans: text(raw.subjectTrans) || null,
    productUrl: text(raw.productUrl) || null,
  };

  const mainImage = productImages[0] ?? null;
  const galleryImages = [
    ...productImages.slice(1),
    ...(whiteImage ? [whiteImage] : []),
  ];
  const data = {
    schemaVersion: 1,
    pageType: 'product',
    source: '1688',
    captureSource: 'linkfox',
    offerId: String(offerKey),
    linkfoxOfferId: String(offerId),
    title: text(raw.subject),
    description: String(raw.description || ''),
    canonicalUrl: `https://detail.1688.com/offer/${offerId}.html`,
    currency: 'CNY',
    price,
    moq: numberOrNull(raw.minOrderQuantity),
    mainImage,
    images: [mainImage, ...galleryImages].filter(Boolean).slice(0, MAX_IMAGES),
    gallery: {
      source: 'linkfox',
      complete: false,
      stable: false,
      imageCount: (mainImage ? 1 : 0) + galleryImages.length,
      exactImageCount: galleryImages.length,
      expectedSlotCount: 0,
      unresolvedSlotCount: 0,
      rounds: 0,
      reason: 'linkfox_gallery_unverified',
    },
    videos: raw.mainVideo || raw.detailVideo
      ? [{ type: 'main', url: text(raw.mainVideo) || text(raw.detailVideo) }] : [],
    skuDimensions,
    skuRows,
    skuOptions,
    skuMatrix: {
      source: 'linkfox',
      priceScale: null,
      rows: skuRows.map((row) => ({
        options: row.options, price: row.price, stock: row.stock, skuId: row.skuId,
      })),
    },
    attributes,
    seller: { name: text(raw.companyName) || null, url: text(raw.productUrl) || null },
    package: shipping ? {
      weightKg: numberOrNull(shipping.weight),
      lengthCm: numberOrNull(shipping.length),
      widthCm: numberOrNull(shipping.width),
      heightCm: numberOrNull(shipping.height),
      officialWeightKg: numberOrNull(shipping.officialWeight),
      officialLengthCm: numberOrNull(shipping.officialLength),
      officialWidthCm: numberOrNull(shipping.officialWidth),
      officialHeightCm: numberOrNull(shipping.officialHeight),
      source: text(shipping.pkgSizeSource) || null,
      sendGoodsAddress: text(shipping.sendGoodsAddressText) || null,
      skuShippingDetails: Array.isArray(shipping.skuShippingDetails) ? shipping.skuShippingDetails.slice(0, 200) : [],
      skuShippingInfoList: Array.isArray(shipping.skuShippingInfoList) ? shipping.skuShippingInfoList.slice(0, 200) : [],
    } : null,
    sellerMetrics: raw.sellerDataInfo ?? null,
    linkfoxExtra,
    linkfox: {
      offerId: String(offerId),
      fetchedAt: new Date().toISOString(),
      sourceTool: text(raw.sourceTool) || null,
      raw,
    },
    parsedAt: new Date().toISOString(),
  };
  return { data, imagePlan };
}

const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif',
};

/** Download every planned image into `product-images/{offerKey}` and return imageFiles rows. */
export async function downloadLinkFoxImages(imagePlan, { storagePath, offerKey }) {
  const root = path.resolve(storagePath, 'product-images');
  const folder = path.resolve(root, offerKey);
  if (!folder.startsWith(`${root}${path.sep}`)) throw new Error('Invalid LinkFox storage folder.');
  await fs.mkdir(folder, { recursive: true });
  const byUrl = new Map();
  const results = [];
  for (const item of imagePlan) {
    const url = String(item.url || '');
    if (!/^https?:/.test(url)) continue;
    if (!byUrl.has(url)) {
      let stored = null;
      try {
        const response = await fetch(url, {
          headers: { referer: 'https://detail.1688.com/', 'user-agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 64) throw new Error('image too small');
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const urlExtension = (url.split('?')[0].match(/\.(jpe?g|png|webp|gif|avif)$/i) || [])[0]?.toLowerCase() || '';
        const extension = MIME_EXTENSIONS[contentType] || urlExtension || '.jpg';
        const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
        stored = {
          contentType: contentType || 'image/jpeg',
          extension,
          contentSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          byteSize: bytes.length,
          hash,
        };
        byUrl.set(url, { ...stored, bytes, folder });
      } catch (error) {
        byUrl.set(url, { error: String(error?.message || error) });
      }
    }
    const stored = byUrl.get(url);
    if (!stored || stored.error) continue;
    const fileName = `${item.type}-${String(item.sortOrder ?? results.length).padStart(4, '0')}-${stored.hash}${stored.extension}`;
    const filePath = path.join(stored.folder, fileName);
    if (!stored.written) {
      await fs.writeFile(filePath, stored.bytes);
      stored.written = true;
    }
    results.push({
      type: item.type,
      sortOrder: item.sortOrder ?? 0,
      sourceUrl: url,
      storagePath: filePath,
      mimeType: stored.contentType,
      contentSha256: stored.contentSha256,
      byteSize: stored.byteSize,
    });
  }
  return results;
}

export function linkfoxExtrasForMerge(raw) {
  const capture = buildLinkFoxCapture(raw, { offerId: text(raw.offerId), offerKey: text(raw.offerId) });
  return {
    linkfox: capture.data.linkfox,
    linkfoxExtra: capture.data.linkfoxExtra,
    package: capture.data.package,
    sellerMetrics: capture.data.sellerMetrics,
  };
}
