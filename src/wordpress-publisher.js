import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeProductMerchandising } from './product-merchandiser.js';

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function getSourceMaximumPrice(detail) {
  const candidates = [detail?.price_min, detail?.price_max];
  for (const sku of detail?.skus ?? []) candidates.push(sku?.price);
  for (const tier of detail?.price_tiers ?? []) {
    candidates.push(tier?.price, tier?.unit_price, tier?.price_value);
  }
  const numbers = candidates.map(numberOrNull).filter((value) => value !== null && value >= 0);
  return numbers.length ? Math.max(...numbers) : null;
}

export function buildWearHongxiuPricing(detail) {
  const sourceMax = getSourceMaximumPrice(detail);
  if (sourceMax === null) throw new Error('A valid non-negative 1688 maximum price is required for pricing.');
  const exchangeRate = 6.5;
  const tiers = [
    { label: '50-299 pcs', min_quantity: 50, max_quantity: 299, cny_markup: 20, price: roundCurrency((sourceMax + 20) / exchangeRate) },
    { label: '300-999 pcs', min_quantity: 300, max_quantity: 999, cny_markup: 15, price: roundCurrency((sourceMax + 15) / exchangeRate) },
    { label: '≥1000 pcs', min_quantity: 1000, max_quantity: null, cny_markup: 10, price: roundCurrency((sourceMax + 10) / exchangeRate) },
  ];
  return { currency: 'USD', source_currency: 'CNY', source_max_price: sourceMax,
    exchange_rate_cny_per_usd: exchangeRate, formula: '(source maximum CNY price + tier markup) / 6.5', tiers };
}

function allSkuRowsInStock(rows) {
  return rows.length > 0 && rows.every((row) => row.source_stock !== null && row.source_stock > 0);
}

function taxonomyById(taxonomies, id) {
  return (taxonomies?.categories ?? []).find((item) => Number(item.id) === Number(id)) ?? null;
}

export function resolveMerchandisingSelection({ options = {}, merchandising = null, taxonomies = null }) {
  const manualCategories = Array.isArray(options.categoryIds) ? options.categoryIds.map(Number).filter(Boolean) : [];
  const categoryMode = clean(options.categoryMode)
    || (manualCategories.length ? 'manual' : 'auto');
  const recommendedPrimary = Number(merchandising?.primaryCategoryId) || 0;
  let primaryCategoryId = Number(options.primaryCategoryId) || recommendedPrimary || manualCategories[0] || 0;
  let categoryIds;
  if (categoryMode === 'manual') categoryIds = manualCategories;
  else if (categoryMode === 'primary_only') categoryIds = primaryCategoryId ? [primaryCategoryId] : [];
  else categoryIds = (merchandising?.categoryIds ?? []).map(Number).filter(Boolean);
  if (primaryCategoryId && !categoryIds.includes(primaryCategoryId)) categoryIds.unshift(primaryCategoryId);

  const manualTags = unique([...(options.tags ?? [])]);
  const tagMode = clean(options.tagMode) || ((options.tagIds?.length || manualTags.length) ? 'manual' : 'auto');
  return {
    primaryCategoryId,
    primaryCategory: clean(taxonomyById(taxonomies, primaryCategoryId)?.name),
    categoryIds: [...new Set(categoryIds)],
    tagIds: tagMode === 'manual' ? (options.tagIds ?? []).map(Number).filter(Boolean) : [],
    tags: tagMode === 'manual' ? manualTags : unique(merchandising?.tags ?? []),
    material: clean(options.material) || clean(merchandising?.material),
    categoryMode,
    tagMode,
  };
}

function translatedAttributeMap(translation) {
  const map = new Map();
  for (const attribute of translation?.attributes ?? []) {
    const name = clean(attribute?.name).toLowerCase();
    if (name) map.set(name, clean(attribute?.value));
  }
  return map;
}

function findDimension(translation, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return (translation?.sku_dimensions ?? []).find(
    (dimension) => wanted.has(clean(dimension?.name).toLowerCase()),
  ) ?? null;
}

function optionValue(options, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(options ?? {})) {
    if (wanted.has(clean(key).toLowerCase())) return clean(value);
  }
  return '';
}

function selectPublishingImages(detail, translation, imageMode = 'translated') {
  const available = new Map((detail.images ?? []).map((image) => [String(image.id), image]));
  const translatedSources = translation?.image_sources ?? [];
  const selected = translatedSources
    .map((source) => available.get(String(source.imageId)))
    .filter(Boolean);

  const fallback = (detail.images ?? [])
    .filter((image) => ['main', 'gallery'].includes(image.image_type))
    .sort((a, b) => {
      if (a.image_type !== b.image_type) return a.image_type === 'main' ? -1 : 1;
      return Number(a.sort_order) - Number(b.sort_order);
    });

  if (imageMode === 'main_only') {
    const main = fallback.find((image) => image.image_type === 'main') ?? fallback[0];
    return main ? [main] : [];
  }

  const source = selected.length ? selected : fallback;
  const seen = new Set();
  return source.filter((image) => {
    const key = clean(image.source_url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSkuMatrix(detail, translation) {
  const translatedRows = new Map(
    (translation?.sku_rows ?? []).map((row) => [clean(row.skuKey), row]),
  );
  return (detail.skus ?? []).map((sku, index) => {
    const translated = translatedRows.get(clean(sku.sku_key)) ?? {};
    const sourceOptions = sku.option_data ?? {};
    const translatedOptions = translated.options ?? {};
    return {
      index,
      source_sku_key: clean(sku.sku_key),
      source_sku_text: clean(sku.sku_text),
      label: clean(translated.skuText) || clean(sku.sku_text) || clean(sku.sku_key),
      options: translatedOptions,
      source_options: sourceOptions,
      color: optionValue(translatedOptions, ['color', '颜色'])
        || optionValue(sourceOptions, ['color', '颜色']),
      size: optionValue(translatedOptions, ['size', '尺码'])
        || optionValue(sourceOptions, ['size', '尺码']),
      source_price: numberOrNull(sku.price),
      source_currency: clean(detail.currency) || 'CNY',
      source_stock: numberOrNull(sku.stock),
      image_source_url: clean(sku.image_source_url),
      available: numberOrNull(sku.stock) === null ? null : Number(sku.stock) > 0,
    };
  });
}

function buildColorOptions(detail, translation, publishingImages) {
  const dimension = findDimension(translation, ['color', '颜色']);
  const colors = unique(dimension?.values ?? []);
  const optionImages = new Map();
  for (const option of translation?.sku_options ?? []) {
    const text = clean(option?.text).replace(/^color\s*:\s*/i, '');
    const imageUrl = clean(option?.imageUrl);
    if (text && imageUrl && !/\b(stock|size|\u5e93\u5b58|\u5c3a\u7801)\b/i.test(text)) optionImages.set(text, imageUrl);
  }
  const defaultImage = publishingImages[0] ?? null;
  return colors.map((label, index) => {
    const imageUrl = optionImages.get(label) || '';
    const matched = publishingImages.find((image) => clean(image.source_url) === imageUrl) ?? defaultImage;
    return {
      label,
      value: `color-${index + 1}`,
      source_image_url: imageUrl,
      image_source_id: matched?.id ? String(matched.id) : '',
    };
  });
}

export function buildWordPressProductDraft({ detail, translation, options = {}, merchandising = null, taxonomies = null }) {
  if (!detail?.id || !detail?.offer_id) throw new Error('A saved product detail with offer_id is required.');
  if (!translation?.id || !clean(translation.title)) throw new Error('An English product translation is required.');

  const attributes = translatedAttributeMap(translation);
  const styleNo = clean(options.styleNo);
  if (!styleNo) throw new Error('A wearhongxiu style number allocation is required.');
  const publishingImages = selectPublishingImages(detail, translation, options.imageMode);
  const sizeDimension = findDimension(translation, ['size', '尺码']);
  const sizes = unique(sizeDimension?.values ?? []);
  const colorOptions = buildColorOptions(detail, translation, publishingImages);
  const skuMatrix = buildSkuMatrix(detail, translation);
  const selection = resolveMerchandisingSelection({ options, merchandising, taxonomies });
  const material = selection.material || attributes.get('fabric composition')
    || attributes.get('fabric name') || 'Polyester';
  const pricing = buildWearHongxiuPricing(detail);
  const hasAllSkuStock = allSkuRowsInStock(skuMatrix);
  const sourceCurrency = clean(detail.currency) || 'CNY';
  const externalId = `1688:${detail.offer_id}`;

  const payload = {
    external_id: externalId,
    style_no: styleNo,
    title: clean(translation.title),
    description: clean(translation.description),
    status: clean(options.status) || 'draft',
    source_updated_at: detail.last_crawled_at || '',
    category_ids: selection.categoryIds,
    tag_ids: selection.tagIds,
    tags: selection.tags,
    meta: {
      sku: styleNo,
      title: clean(translation.title),
      description: clean(translation.description),
      style: selection.primaryCategory,
      primary_category_id: selection.primaryCategoryId ? String(selection.primaryCategoryId) : '',
      primary_category: selection.primaryCategory,
      sample_available: hasAllSkuStock,
      sample_price: '50.00',
      sample_lead_time: hasAllSkuStock ? '3 working days' : '7 to 14 working days',
      lead_time: hasAllSkuStock ? '3 working days' : '7 to 14 working days',
      moq: '50 pcs',
      bulk_lead_time: '~28 days',
      material,
      fabric_weight: '200gsm',
      customizable: true,
      customization: 'Yes',
      stripe_price_id: '',
      source_type: '1688',
      notes: '',
      source_platform: '1688',
      source_offer_id: String(detail.offer_id),
      source_url: clean(detail.canonical_url) || clean(detail.source_url),
      source_seller_name: clean(translation.seller_name) || clean(detail.seller_name),
      source_seller_url: clean(detail.seller_url),
      source_currency: sourceCurrency,
      source_price_min: numberOrNull(detail.price_min),
      source_price_max: numberOrNull(detail.price_max),
      source_product_detail_id: String(detail.id),
      source_translation_id: String(translation.id),
    },
    images: publishingImages.map((image, index) => ({
      source_image_id: String(image.id),
      source_url: clean(image.source_url),
      storage_path: clean(image.storage_path),
      mime_type: clean(image.mime_type) || 'image/jpeg',
      image_type: clean(image.image_type),
      sort_order: Number(image.sort_order) || 0,
      alt: `${clean(translation.title)}${index ? ` view ${index + 1}` : ''}`,
    })),
    bulk_pricing: pricing,
    sizes: sizes.length ? {
      default: sizes[0],
      sizes: sizes.map((value) => ({ label: value, value })),
    } : null,
    size_chart: null,
    colors: colorOptions.length ? {
      default: colorOptions[0].value,
      colors: colorOptions,
    } : null,
    sku_matrix: {
      schema_version: 1,
      source_currency: sourceCurrency,
      rows: skuMatrix,
    },
    source_attributes: translation.attributes ?? [],
    source: {
      platform: '1688',
      offer_id: String(detail.offer_id),
      product_detail_id: String(detail.id),
      translation_id: String(translation.id),
      url: clean(detail.canonical_url) || clean(detail.source_url),
      seller_name: clean(translation.seller_name) || clean(detail.seller_name),
      seller_url: clean(detail.seller_url),
      currency: sourceCurrency,
      price_min: numberOrNull(detail.price_min),
      price_max: numberOrNull(detail.price_max),
      collected_at: detail.last_crawled_at || '',
      merchandising: merchandising ? {
        model: merchandising.model || '', confidence: merchandising.confidence ?? null,
        category_mode: selection.categoryMode, tag_mode: selection.tagMode,
      } : null,
    },
  };

  return { externalId, styleNo, publishingImages, payload };
}

function extensionForMime(mimeType) {
  const map = {
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
  };
  return map[mimeType] || 'jpg';
}

function wordpressClient(config) {
  const baseUrl = clean(config.wordpressBaseUrl).replace(/\/+$/, '');
  const username = clean(config.wordpressUsername);
  const password = clean(config.wordpressApplicationPassword);
  if (!baseUrl || !username || !password) throw new Error('WordPress publishing credentials are not configured.');
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  return async function request(endpoint, options = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: { Accept: 'application/json', Authorization: authorization, ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(options.timeoutMs ?? 60000),
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(body.message || body.error || `WordPress request failed (${response.status}).`);
    return body;
  };
}

export async function prepareWordPressProductDraft({
  detail, translation, options = {}, config, reserveStyleNumber = false,
}) {
  const wp = wordpressClient(config);
  const taxonomies = await wp('/wp-json/hx/v1/products/taxonomies');
  const needsCategoryModel = !(Array.isArray(options.categoryIds) && options.categoryIds.length)
    || clean(options.categoryMode) === 'auto' || clean(options.categoryMode) === 'primary_only';
  const needsTagModel = !(Array.isArray(options.tagIds) && options.tagIds.length)
    && !(Array.isArray(options.tags) && options.tags.length) || clean(options.tagMode) === 'auto';
  const needsMaterialModel = !clean(options.material);
  const merchandising = (needsCategoryModel || needsTagModel || needsMaterialModel)
    ? await analyzeProductMerchandising({ detail, translation, taxonomies, config: {
      apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
      complexModel: config.complexModel, storagePath: config.storagePath,
      modelImageTransport: config.modelImageTransport,
    } }) : null;
  const selection = resolveMerchandisingSelection({ options, merchandising, taxonomies });
  let styleNo = clean(options.styleNo);
  if (!styleNo) {
    if (!selection.primaryCategoryId) throw new Error('A primary category is required before allocating a style number.');
    const allocated = await wp('/wp-json/hx/v1/products/style-number', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_id: `1688:${detail.offer_id}`,
        primary_category_id: selection.primaryCategoryId,
        reserve: reserveStyleNumber,
      }),
    });
    styleNo = clean(allocated.style_no);
  }
  return buildWordPressProductDraft({
    detail, translation, options: { ...options, styleNo }, merchandising, taxonomies,
  });
}

function resolveStorageFile(storagePath, filename) {
  const root = path.resolve(storagePath);
  const resolved = path.resolve(filename);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Product image path is outside persistent storage.');
  }
  return resolved;
}

export async function publishProductToWordPress({ detail, translation, options = {}, config }) {
  const draft = await prepareWordPressProductDraft({
    detail, translation, options, config, reserveStyleNumber: true,
  });
  const wp = wordpressClient(config);
  const media = [];

  for (const [index, image] of draft.publishingImages.entries()) {
    if (!image.storage_path) continue;
    const absolutePath = resolveStorageFile(config.storagePath, image.storage_path);
    const binary = await fs.readFile(absolutePath);
    const mimeType = clean(image.mime_type) || 'image/jpeg';
    const sourceKeyHash = crypto.createHash('sha1').update(clean(image.source_url)).digest('hex');
    const uploaded = await wp('/wp-json/hx/v1/products/media/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_id: draft.externalId,
        source_key: `1688:${detail.offer_id}:${image.image_type}:${image.sort_order}:${sourceKeyHash}`,
        local_url: clean(image.source_url),
        filename: `${draft.styleNo}-${index + 1}.${extensionForMime(mimeType)}`,
        mime_type: mimeType,
        alt: draft.payload.images[index]?.alt || draft.payload.title,
        base64: binary.toString('base64'),
      }),
      timeoutMs: 120000,
    });
    media.push({
      sourceImageId: String(image.id),
      attachmentId: Number(uploaded.attachment_id || uploaded.id),
      url: clean(uploaded.url),
    });
  }

  if (!media.length) throw new Error('No persistent-storage product images could be uploaded.');
  const mediaBySourceId = new Map(media.map((item) => [item.sourceImageId, item]));
  const payload = {
    ...draft.payload,
    images: draft.payload.images.map((image) => {
      const uploaded = mediaBySourceId.get(image.source_image_id);
      return uploaded ? {
        attachment_id: uploaded.attachmentId,
        alt: image.alt,
        source_url: image.source_url,
        url: uploaded.url,
      } : null;
    }).filter(Boolean),
    colors: draft.payload.colors ? {
      ...draft.payload.colors,
      colors: draft.payload.colors.colors.map((color) => {
        const uploaded = mediaBySourceId.get(color.image_source_id);
        return {
          label: color.label,
          value: color.value,
          ...(uploaded?.attachmentId ? { image_id: uploaded.attachmentId } : {}),
        };
      }),
    } : null,
  };

  const result = await wp('/wp-json/hx/v1/products/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 120000,
  });
  return { draft, payload, media, wordpress: result };
}
