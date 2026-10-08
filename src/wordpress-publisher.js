import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeProductMerchandising } from './product-merchandiser.js';
import { applyReasoning } from './model-request.js';
import { dedupeImagesByHash, normalizedSourceImageKey } from './image-dedupe.js';
import { applyOptionMapOverrides, buildOptionOverrideIndex,
  resolveOptionDisplayLabel } from './option-overrides.js';

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

export function normalizePublicationDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export function get1688ArrivalDate(detail) {
  if (clean(detail?.publication_date_source) !== '1688_listing_time') return '';
  const normalized = normalizePublicationDate(detail?.publication_date);
  if (!normalized) return '';
  const date = new Date(normalized);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function getSourceMaximumPrice(detail) {
  const skuPrices = (detail?.skus ?? []).map((sku) => numberOrNull(sku?.price))
    .filter((value) => value !== null && value >= 0);
  const priceVerified = detail?.raw_data?.price?.verified === true;
  const candidates = [...skuPrices];
  if (priceVerified) {
    candidates.push(detail?.price_min, detail?.price_max);
    for (const tier of [...(detail?.price_tiers ?? []), ...(detail?.priceTiers ?? [])]) {
      candidates.push(tier?.price, tier?.unit_price, tier?.price_value);
    }
  }
  const numbers = candidates.map(numberOrNull).filter((value) => value !== null && value >= 0);
  return numbers.length ? Math.max(...numbers) : null;
}

export function buildWearHongxiuPricing(detail, { sourceMaxOverride = null } = {}) {
  const override = sourceMaxOverride === null || sourceMaxOverride === undefined
    ? null : numberOrNull(sourceMaxOverride);
  const sourceMax = override === null ? getSourceMaximumPrice(detail) : override;
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

function selectPublishingImages(detail, translation, imageMode = 'translated', allowUnverifiedGallery = false) {
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

  if (detail?.raw_data?.gallery?.complete !== true && allowUnverifiedGallery !== true) {
    throw new Error('A complete, verified 1688 product Gallery is required before full-image publishing.');
  }

  // Model input is deliberately bounded, but WordPress should receive every
  // image from the verified product Gallery after the prioritized subset.
  const source = selected.length ? [...selected, ...fallback] : fallback;
  const seen = new Set();
  let kept = source.filter((image) => {
    const key = normalizedSourceImageKey(image.source_url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Duplicate removal for publishing: stored dedupe decisions (exact / near /
  // LLM-confirmed) plus a live exact-content-hash guard. Files stay on disk.
  const removedIds = new Set((Array.isArray(detail?.raw_data?.imageDedupe?.removed)
    ? detail.raw_data.imageDedupe.removed : [])
    .map((entry) => String(entry?.imageId ?? ''))
    .filter(Boolean));
  if (removedIds.size) kept = kept.filter((image) => !removedIds.has(String(image.id)));
  const seenSha = new Set();
  kept = kept.filter((image) => {
    const sha = clean(image.content_sha256);
    if (sha && seenSha.has(sha)) return false;
    if (sha) seenSha.add(sha);
    return true;
  });
  return kept;
}

function buildSkuMatrix(detail, translation, overrideIndex = null) {
  const droppedColours = droppedVariantColours(detail);
  const translatedRows = new Map(
    (translation?.sku_rows ?? []).map((row) => [clean(row.skuKey), row]),
  );
  return (detail.skus ?? [])
    .filter((sku) => {
      if (!droppedColours.size) return true;
      return !Object.values(sku.option_data ?? {})
        .some((value) => droppedColours.has(clean(value)));
    })
    .map((sku, index) => {
    const translated = translatedRows.get(clean(sku.sku_key)) ?? {};
    const sourceOptions = sku.option_data ?? {};
    const translatedOptions = translated.options ?? {};
    const colorOption = optionValue(translatedOptions, ['color', '颜色'])
      || optionValue(sourceOptions, ['color', '颜色']);
    const colorLabel = resolveOptionDisplayLabel(overrideIndex, colorOption) || colorOption;
    const sizeLabel = optionValue(translatedOptions, ['size', '尺码'])
      || optionValue(sourceOptions, ['size', '尺码']);
    const translatedDisplayOptions = applyOptionMapOverrides(translatedOptions, overrideIndex);
    // Some legacy translations carry no per-row option labels; fall back to the
    // row's own display labels so the matrix never ships empty options.
    const displayOptions = Object.keys(translatedDisplayOptions ?? {}).length
      ? translatedDisplayOptions
      : {
        ...(colorLabel ? { Color: colorLabel } : {}),
        ...(sizeLabel ? { Size: sizeLabel } : {}),
      };
    return {
      index,
      source_sku_key: clean(sku.sku_key),
      source_sku_text: clean(sku.sku_text),
      label: clean(translated.skuText) || clean(sku.sku_text) || clean(sku.sku_key),
      // Display copy is renamed; source_options below keeps the captured text.
      options: displayOptions,
      source_options: sourceOptions,
      color: colorLabel,
      size: sizeLabel,
      source_price: numberOrNull(sku.price),
      source_currency: clean(detail.currency) || 'CNY',
      source_stock: numberOrNull(sku.stock),
      image_source_url: clean(sku.image_source_url),
      available: numberOrNull(sku.stock) === null ? null : Number(sku.stock) > 0,
      supplier_sku: clean(sku.variant_sku) || null,
    };
  });
}

function normalizedImageKey(value) {
  return clean(value).replace(/[?#].*$/, '')
    .replace(/_\.webp$/i, '')
    .replace(/_\d+x\d+[^/]*$/i, '');
}

function buildNormalizedTranslatedMap(translation, entries, dimensionNames) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const bySource = new Map(entries.map((entry) => [clean(entry?.source), entry]));
  const sourceOptions = Array.isArray(translation?.source_data?.skuOptions)
    ? translation.source_data.skuOptions : [];
  const map = new Map();
  for (const option of translation?.sku_options ?? []) {
    const dimensionName = clean(option?.dimensionName).toLowerCase();
    if (dimensionName && !dimensionNames.includes(dimensionName)) continue;
    const translatedText = clean(option?.text);
    const sourceText = clean(sourceOptions[Number(option?.index)]?.text);
    const hit = bySource.get(sourceText);
    if (translatedText && hit) map.set(translatedText, hit);
  }
  return map.size ? map : null;
}

/**
 * Source colour texts dropped by the pipeline's variant drop policy; they are
 * excluded from the published colours and SKU rows everywhere.
 */
function droppedVariantColours(detail) {
  const colours = detail?.raw_data?.variantDrops?.colours;
  return new Set((Array.isArray(colours) ? colours : [])
    .map((entry) => clean(typeof entry === 'string' ? entry : entry?.source)).filter(Boolean));
}

function buildColorOptions(detail, translation, overrideIndex = null, normalizedColours = null) {
  const dimension = findDimension(translation, ['color', '颜色']);
  const colors = unique(dimension?.values ?? []);
  const optionImages = new Map();
  for (const option of translation?.sku_options ?? []) {
    const dimensionName = clean(option?.dimensionName).toLowerCase();
    if (dimensionName && !['color', '颜色'].includes(dimensionName)) continue;
    const text = clean(option?.text).replace(/^color\s*:\s*/i, '');
    const imageUrl = clean(option?.imageUrl);
    // Skip option texts that are really size/stock labels ("Size: M", "库存5"),
    // but keep genuine colour names that merely mention a size, such as
    // "BH25254B30 One Size Cover-up".
    const labelOnly = /^(stock|size|库存|尺码)(\s*[:：].*)?$/i.test(text);
    if (text && imageUrl && !labelOnly) optionImages.set(text, imageUrl);
  }
  const skuImages = new Map((detail.images ?? [])
    .filter((image) => image.image_type === 'sku')
    .map((image) => [normalizedImageKey(image.source_url), image]));
  return colors.map((sourceLabel, index) => {
    // The swatch image is keyed by the captured text, so resolve it before the
    // display label is replaced by an override.
    const imageUrl = optionImages.get(sourceLabel) || '';
    const matched = skuImages.get(normalizedImageKey(imageUrl)) ?? null;
    // Priority: variant-normalization text/code > manual override > translated label.
    const normalized = normalizedColours?.get(clean(sourceLabel)) ?? null;
    const label = clean(normalized?.text)
      || resolveOptionDisplayLabel(overrideIndex, sourceLabel) || sourceLabel;
    return {
      label,
      value: `color-${index + 1}`,
      ...(label === sourceLabel ? {} : { source_label: sourceLabel }),
      ...(clean(normalized?.code) ? { code: clean(normalized.code) } : {}),
      source_image_url: imageUrl,
      image_source_id: matched?.id ? String(matched.id) : (clean(normalized?.imageId) || ''),
    };
  });
}

// Re-applies the manual option overrides to an already saved publication
// payload. Price, style-number, and date repairs replay that payload verbatim,
// so a payload saved before an override existed would otherwise write the
// captured label back to WordPress.
export function applyOptionOverridesToPayload(payload, optionOverrides = []) {
  const index = buildOptionOverrideIndex(optionOverrides);
  if (!payload || typeof payload !== 'object' || index.size === 0) return payload;
  const next = structuredClone(payload);
  if (Array.isArray(next.colors?.colors)) {
    next.colors.colors = next.colors.colors.map((color) => {
      const label = resolveOptionDisplayLabel(index, color?.source_label ?? color?.label);
      return label && label !== color?.label ? { ...color, label } : color;
    });
  }
  if (Array.isArray(next.sku_matrix?.rows)) {
    next.sku_matrix.rows = next.sku_matrix.rows.map((row) => {
      const label = resolveOptionDisplayLabel(index, row?.color ?? row?.options?.Color);
      if (!label) return row;
      return { ...row, color: label, options: applyOptionMapOverrides(row?.options, index) };
    });
  }
  return next;
}

export function buildWordPressProductDraft({ detail, translation, options = {}, merchandising = null, taxonomies = null, optionOverrides = [] }) {
  if (!detail?.id || !detail?.offer_id) throw new Error('A saved product detail with offer_id is required.');
  if (!translation?.id || !clean(translation.title)) throw new Error('An English product translation is required.');

  const attributes = translatedAttributeMap(translation);
  const styleNo = clean(options.styleNo);
  if (!styleNo) throw new Error('A wearhongxiu style number allocation is required.');
  // Manual option-label overrides are applied to every payload this module
  // builds, so a re-capture or a swatch repair cannot revert a corrected name.
  const overrideIndex = buildOptionOverrideIndex(optionOverrides);
  const publishingImages = selectPublishingImages(
    detail, translation, options.imageMode, options.allowUnverifiedGallery === true,
  );
  const sizeDimension = findDimension(translation, ['size', '尺码']);
  const sizes = unique(sizeDimension?.values ?? []);
  const normalizedColours = buildNormalizedTranslatedMap(translation, options.normalizedVariants?.colours, ['color', '颜色']);
  const normalizedSizes = buildNormalizedTranslatedMap(translation, options.normalizedVariants?.sizes, ['size', '尺码']);
  const sizeLabel = (value) => clean(normalizedSizes?.get(clean(value))?.text) || value;
  const droppedColours = droppedVariantColours(detail);
  const colorOptions = buildColorOptions(detail, translation, overrideIndex, normalizedColours)
    .filter((color) => !droppedColours.size || !droppedColours.has(clean(color.source_label ?? color.label)));
  const swatchImageIds = new Set(colorOptions.map((color) => color.image_source_id).filter(Boolean));
  const swatchImages = options.imageMode === 'main_only' ? []
    : (detail.images ?? []).filter((image) => swatchImageIds.has(String(image.id)));
  const uploadImages = [...publishingImages, ...swatchImages]
    .filter((image, index, values) => values.findIndex((candidate) => String(candidate.id) === String(image.id)) === index);
  const skuMatrix = buildSkuMatrix(detail, translation, overrideIndex);
  const selection = resolveMerchandisingSelection({ options, merchandising, taxonomies });
  const material = selection.material || attributes.get('fabric composition')
    || attributes.get('fabric name') || 'Polyester';
  const pricing = buildWearHongxiuPricing(detail);
  const hasAllSkuStock = allSkuRowsInStock(skuMatrix);
  const sourceCurrency = clean(detail.currency) || 'CNY';
  const externalId = `1688:${detail.offer_id}`;
  const publicationDate = normalizePublicationDate(detail.publication_date || detail.first_seen_at);
  const arrivalDate = get1688ArrivalDate(detail);

  const payload = {
    external_id: externalId,
    style_no: styleNo,
    title: clean(translation.title),
    description: clean(translation.description),
    status: clean(options.status) || 'draft',
    publication_date: publicationDate,
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
      ...(arrivalDate ? { arrival_date: arrivalDate } : {}),
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
      default: sizeLabel(sizes[0]),
      sizes: sizes.map((value) => ({ label: sizeLabel(value), value })),
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
      publication_date: publicationDate,
      publication_date_source: clean(detail.publication_date_source) || 'first_seen_at',
      gallery_source: clean(detail?.raw_data?.gallery?.source) || null,
      gallery_verified_complete: detail?.raw_data?.gallery?.complete === true,
      merchandising: merchandising ? {
        model: merchandising.model || '', confidence: merchandising.confidence ?? null,
        category_mode: selection.categoryMode, tag_mode: selection.tagMode,
      } : null,
    },
  };

  return { externalId, styleNo, publishingImages, swatchImages, uploadImages, payload };
}

export async function setWordPressProductPublicationDate({ postId, publicationDate, config }) {  const normalized = normalizePublicationDate(publicationDate);
  if (!Number(postId) || !normalized) throw new Error('A WordPress post ID and valid publication date are required.');
  const wp = wordpressClient(config);
  return wp(`/wp-json/wp/v2/product/${Number(postId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date_gmt: normalized }),
  });
}

export async function setWordPressProductArrivalDate({ postId, externalId, arrivalDate, config }) {
  if (!Number(postId)) throw new Error('A WordPress post ID is required.');
  if (!/^\d{8}$/.test(clean(arrivalDate))) throw new Error('A valid YYYYMMDD arrival date is required.');
  const wp = wordpressClient(config);
  return wp('/wp-json/hx/v1/products/arrival-date', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_id: Number(postId),
      external_id: clean(externalId),
      arrival_date: clean(arrivalDate),
    }),
  });
}

export async function setWordPressProductStatus({ postId, status, config }) {
  const allowedStatuses = new Set(['draft', 'pending', 'publish', 'private']);
  if (!Number(postId)) throw new Error('A WordPress post ID is required.');
  if (!allowedStatuses.has(status)) throw new Error('Unsupported WordPress product status.');
  const wp = wordpressClient(config);
  return wp(`/wp-json/wp/v2/product/${Number(postId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

async function mapConcurrent(values, concurrency, action) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { ok: true, value: await action(values[index]) };
      } catch (error) {
        results[index] = { ok: false, error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function replaceWordPressBestSellers({ postIds, config, categorySlug = 'best-sellers' }) {
  const selectedIds = [...new Set((postIds ?? []).map(Number).filter(Boolean))];
  const wp = wordpressClient(config);
  const terms = await wp(`/wp-json/wp/v2/product_cat?slug=${encodeURIComponent(categorySlug)}&per_page=100&context=edit`);
  const termId = Number(terms?.[0]?.id);
  if (!termId) throw new Error(`WordPress product category ${categorySlug} was not found.`);
  const current = await wp(`/wp-json/wp/v2/product?product_cat=${termId}&status=publish&per_page=100&context=edit&_fields=id,product_cat`);
  const currentIds = new Set((current ?? []).map((product) => Number(product.id)).filter(Boolean));
  const selectedSet = new Set(selectedIds);
  const affectedIds = [...new Set([...currentIds, ...selectedIds])];

  const changes = await mapConcurrent(affectedIds, 5, async (postId) => {
    const product = await wp(`/wp-json/wp/v2/product/${postId}?context=edit&_fields=id,status,product_cat`);
    if (product.status !== 'publish' && selectedSet.has(postId)) {
      throw new Error('Selected product is no longer published.');
    }
    const before = [...new Set((product.product_cat ?? []).map(Number).filter(Boolean))];
    const after = selectedSet.has(postId)
      ? [...new Set([...before, termId])]
      : before.filter((id) => id !== termId);
    if (before.length === after.length && before.every((id) => after.includes(id))) {
      return { postId, changed: false, selected: selectedSet.has(postId) };
    }
    await wp(`/wp-json/wp/v2/product/${postId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_cat: after }),
    });
    return { postId, changed: true, selected: selectedSet.has(postId) };
  });

  const failures = changes.filter((item) => !item.ok);
  return {
    termId,
    currentBefore: currentIds.size,
    selected: selectedIds.length,
    updated: changes.filter((item) => item.ok && item.value.changed).length,
    added: changes.filter((item) => item.ok && item.value.changed && item.value.selected).length,
    removed: changes.filter((item) => item.ok && item.value.changed && !item.value.selected).length,
    unchanged: changes.filter((item) => item.ok && !item.value.changed).length,
    failed: failures.length,
    errors: failures.map((item) => item.error),
  };
}

export async function syncWordPressProductPricing({ detail, publication, config }) {
  const existingPayload = publication?.payload;
  if (!existingPayload?.external_id || !existingPayload?.title) {
    throw new Error('The saved WordPress publication payload is incomplete.');
  }
  const payload = refreshWordPressProductPricingPayload(existingPayload, detail);
  const wp = wordpressClient(config);
  const result = await wp('/wp-json/hx/v1/products/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 120000,
  });
  return { payload, wordpress: result };
}

export function refreshWordPressProductPricingPayload(existingPayload, detail) {
  const pricing = buildWearHongxiuPricing(detail);
  const sourceMin = numberOrNull(detail?.price_min);
  const sourceMax = numberOrNull(detail?.price_max);
  return {
    ...existingPayload,
    bulk_pricing: pricing,
    meta: {
      ...(existingPayload?.meta ?? {}),
      source_price_min: sourceMin,
      source_price_max: sourceMax,
    },
    source: {
      ...(existingPayload?.source ?? {}),
      price_min: sourceMin,
      price_max: sourceMax,
    },
  };
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

export function isValidImagePayload(contentType, binary) {
  if (!String(contentType || '').toLowerCase().startsWith('image/')) return false;
  if (!Buffer.isBuffer(binary) || binary.length < 1024) return false;
  const isJpeg = binary[0] === 0xff && binary[1] === 0xd8 && binary[2] === 0xff;
  const isPng = binary.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isGif = ['GIF87a', 'GIF89a'].includes(binary.subarray(0, 6).toString('ascii'));
  const isWebp = binary.subarray(0, 4).toString('ascii') === 'RIFF'
    && binary.subarray(8, 12).toString('ascii') === 'WEBP';
  const isAvif = binary.subarray(4, 8).toString('ascii') === 'ftyp'
    && ['avif', 'avis'].includes(binary.subarray(8, 12).toString('ascii'));
  return isJpeg || isPng || isGif || isWebp || isAvif;
}

async function verifyPublicImage(url, { attempts = 2 } = {}) {
  let last = { ok: false, status: 0, contentType: '', bytes: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; WearHongxiuImageVerifier/1.0)',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      const binary = Buffer.from(await response.arrayBuffer());
      const contentType = clean(response.headers.get('content-type')).toLowerCase();
      last = { ok: response.ok && isValidImagePayload(contentType, binary),
        status: response.status, contentType, bytes: binary.length };
      if (last.ok) return last;
    } catch (error) {
      last = { ok: false, status: 0, contentType: '', bytes: 0, error: error.message };
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  return last;
}

async function uploadVerifiedWordPressImage({ wp, draft, detail, image, index, binary, mimeType }) {
  const sourceKeyHash = crypto.createHash('sha1').update(clean(image.source_url)).digest('hex');
  const contentHash = crypto.createHash('sha256').update(binary).digest('hex').slice(0, 16);
  let lastVerification = null;
  for (let uploadAttempt = 0; uploadAttempt < 2; uploadAttempt += 1) {
    const repairSuffix = uploadAttempt
      ? `:availability-repair:${contentHash}:${Date.now()}` : '';
    const uploaded = await wp('/wp-json/hx/v1/products/media/ensure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_id: draft.externalId,
        source_key: `1688:${detail.offer_id}:${image.image_type}:${image.sort_order}:${sourceKeyHash}${repairSuffix}`,
        local_url: clean(image.source_url),
        filename: `${draft.styleNo}-${index + 1}${uploadAttempt ? '-availability-repair' : ''}.${extensionForMime(mimeType)}`,
        mime_type: mimeType,
        alt: draft.payload.images[index]?.alt || draft.payload.title,
        base64: binary.toString('base64'),
      }),
      timeoutMs: 120000,
    });
    const url = clean(uploaded.url);
    lastVerification = url ? await verifyPublicImage(url) : {
      ok: false, status: 0, contentType: '', bytes: 0, error: 'WordPress returned no media URL.',
    };
    if (lastVerification.ok) return { uploaded, verification: lastVerification,
      repaired: uploadAttempt > 0 };
  }
  throw new Error(`WordPress image availability verification failed (${lastVerification?.status || 'network'}).`);
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

export async function resolveWordPressProduct(identifier, config) {
  const wp = wordpressClient(config);
  const query = new URLSearchParams(identifier).toString();
  return wp(`/wp-json/hx/v1/products/resolve?${query}`, { timeoutMs: 30000 });
}

// --- split-product publishing -------------------------------------------------

async function pickSplitCategory({ content, categories, config }) {
  const list = categories.map((item) => `${item.id}: ${item.name}`).join('\n');
  if (!list) return null;
  const base = clean(config.modelBaseUrl).replace(/\/+$/, '') || 'https://api.deepseek.com';
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}${base.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const prompt = `你是电商选品助手，只输出严格JSON。
从下面的类目列表里，为这个商品选择最合适的一个主类目（必须是列表中的 id）：
${list}

商品标题：${JSON.stringify(clean(content?.title))}
商品描述：${JSON.stringify(clean(content?.description).slice(0, 400))}
输出：{"categoryId": 数字, "reason": "一句话"}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.modelApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(applyReasoning({
      model: config.complexModel,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 384000,
    }, config.reasoningEffort)),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  const text = contentTextOf(payload?.choices?.[0]?.message?.content);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const categoryId = Number(parsed?.categoryId);
  return categories.some((item) => Number(item.id) === categoryId) ? categoryId : null;
}

function normalizeReviewTitle(value) {
  const title = clean(value).replace(/\s+/g, ' ').slice(0, 160);
  if (!title) return null;
  const words = title.split(' ').filter(Boolean).length;
  return words >= 2 && words <= 20 ? title : null;
}

function normalizeReviewDescription(value) {
  const description = clean(value).replace(/\s+/g, ' ').slice(0, 1200);
  if (!description) return null;
  const words = description.split(' ').filter(Boolean).length;
  return words >= 20 && words <= 200 ? description : null;
}

/**
 * Grounds one split product in the original listing's option texts: picks the
 * category of this product's own item (never the bundle) and, when the
 * generated title/description describe pieces that belong to sibling products,
 * returns corrected copy. Text-only, validated.
 */
async function reviewSplitProduct({ content, options, categories, currentCategoryId, config }) {
  const list = categories.map((item) => `${item.id}: ${item.name}`).join('\n');
  if (!list) return null;
  const base = clean(config.modelBaseUrl).replace(/\/+$/, '') || 'https://api.deepseek.com';
  const endpoint = base.endsWith('/chat/completions') ? base : `${base}${base.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
  const current = categories.find((item) => Number(item.id) === Number(currentCategoryId)) ?? null;
  const optionTexts = (Array.isArray(options) ? options : []).map((value) => clean(value)).filter(Boolean);
  const colourCount = Array.isArray(content?.colours) ? content.colours.length : 0;
  const singleVariant = colourCount === 1;
  const variantName = singleVariant ? clean(content.colours[0]?.text) || clean(content.colours[0]?.source) : '';
  const variantRule = singleVariant
    ? `本商品只有一个颜色/印花变体（规范名：${JSON.stringify(variantName)}）：标题或描述中必须体现该颜色/印花。`
    : `本商品有 ${colourCount} 个颜色/印花变体：标题和描述中都不得出现任何颜色、印花或图案词。`;
  const prompt = `你是电商选品助手，只输出严格JSON。
一个 1688 捆绑 listing 被拆成多个独立商品，下面是其中一个拆分商品：
- 它在原 listing 中对应的选项原文（判断品类的唯一权威依据）：${JSON.stringify(optionTexts)}
- 计划中的中文参考名：${JSON.stringify(clean(content?.name))}
- 当前英文标题：${JSON.stringify(clean(content?.title))}
- 当前英文描述：${JSON.stringify(clean(content?.description).slice(0, 600))}
- 当前主类目：${JSON.stringify(current?.name ?? '')}

任务：
1. 根据"选项原文"判断这件商品实际卖的是什么（如比基尼、泳衣上衣、泳裤、沙滩裙/罩衫、三件套等），从类目列表选一个最合适的主类目（必须是列表中的 id）。不要被标题提到的其它部件误导。
2. 检查当前标题和描述是否只写了"选项原文"代表的这件商品：
   - 若写进了原 listing 的其它部件（例如选项只有"比基尼"却写了 with matching skirt / three-piece set / wrap skirt），或品类判断错误，给出修正版；
   - ${variantRule}
   - 标题规则：4–15 个英文单词的稳定产品名，必须清楚体现产品特点（品类、结构、剪裁、部件），不得过于笼统或过短；不含年份、平台名、尺码词（如 One Size、XL）、促销词，只描述这件商品；
   - 描述规则：35–120 个英文单词的单段产品级描述，只保留属于这件商品的可见特征（品类、轮廓、领型、肩带、罩杯结构、开合、覆盖度、剪裁），颜色/印花规则同上；不得写单个 SKU、促销、年份、平台、材质、功能或不可见信息；可参考当前描述中属于这件商品的部分；
   - 若当前标题/描述已经符合以上规则，对应字段返回 null。
输出：{"categoryId": 数字, "title": "修正标题" 或 null, "description": "修正描述" 或 null, "reason": "一句话"}

类目列表：
${list}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.modelApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(applyReasoning({
      model: config.complexModel,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 384000,
    }, config.reasoningEffort)),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  const text = contentTextOf(payload?.choices?.[0]?.message?.content);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed) return null;
  const categoryId = Number(parsed?.categoryId);
  const category = categories.find((item) => Number(item.id) === categoryId) ?? null;
  return {
    categoryId: category ? category.id : null,
    title: normalizeReviewTitle(parsed?.title),
    description: normalizeReviewDescription(parsed?.description),
    reason: clean(parsed?.reason),
  };
}

function contentTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

function normalizedUrlKey(value) {
  // 1688 serves one image as `x.jpg` and `x.jpg_.webp`; both must collapse to
  // the same key or swatch attachments are never matched.
  return normalizedSourceImageKey(value);
}

/**
 * Publish the split products of one bundle: update the original WordPress post
 * with the best-matching split product (keeping its URL, style number and
 * taxonomies) and create the remaining split products as new drafts (fresh
 * style numbers from their own category, external ids suffixed `S{n}`).
 * Existing attachments are reused; only genuinely new images are uploaded.
 */
export async function publishSplitProductsToWordPress({ detail, contents, publication, plan = null, skipReview = false, config }) {
  const wp = wordpressClient(config);
  const template = publication?.payload ?? null;
  if (!template) throw new Error('A stored publication payload is required.');
  const products = (Array.isArray(contents?.products) ? contents.products : []).filter((item) => item?.title);
  if (!products.length) throw new Error('Split contents with titles are required.');
  const taxonomies = await wp('/wp-json/hx/v1/products/taxonomies');
  const allCategories = (taxonomies?.categories ?? []).filter((item) => item?.id && item?.name);
  const detailImages = new Map((detail?.images ?? []).map((image) => [String(image.id), image]));
  const previousImages = new Map((template.images ?? [])
    .map((image) => [normalizedUrlKey(image?.source_url), image]));

  // Original option texts per split product (authoritative for the item type)
  // plus what a previous publish already recorded for the product.
  const planProducts = new Map((Array.isArray(plan?.products) ? plan.products : [])
    .map((item) => [String(item?.id ?? ''), item]));
  const optionsFor = (content) => {
    const fromPlan = planProducts.get(String(content?.id ?? ''))?.options;
    if (Array.isArray(fromPlan) && fromPlan.length) return fromPlan.map((value) => clean(value)).filter(Boolean);
    return (content?.colours ?? []).map((colour) => clean(colour?.source)).filter(Boolean);
  };
  const storedWp = new Map((Array.isArray(contents?.products) ? contents.products : [])
    .map((item) => [String(item?.id ?? ''), item?.wp ?? null]));

  const attachmentFor = (url) => previousImages.get(normalizedUrlKey(url)) ?? null;

  // Each split product prices from its OWN option group's SKU prices (the
  // bundle-wide maximum would give every split product the same price).
  const pricingFor = (content) => {
    const own = (content?.skus ?? [])
      .map((sku) => numberOrNull(sku?.price))
      .filter((value) => value !== null && value > 0);
    if (!own.length) {
      const fallback = buildWearHongxiuPricing(detail);
      return { pricing: fallback, sourceMin: null, sourceMax: fallback.source_max_price };
    }
    const sourceMax = Math.max(...own);
    const sourceMin = Math.min(...own);
    return {
      pricing: buildWearHongxiuPricing(detail, { sourceMaxOverride: sourceMax }),
      sourceMin, sourceMax,
    };
  };

  // Swatch attachments for colour options: reuse what the template already
  // uploaded, otherwise resolve the colour's image from ANY stored image (the
  // colour's picture is often stored as a gallery/detail image, not a SKU
  // image), and download it directly as a last resort.
  const imageByUrlKey = new Map((detail?.images ?? [])
    .map((image) => [normalizedUrlKey(image.source_url), image])
    .filter(([key]) => Boolean(key)));
  const swatchCache = new Map();
  const swatchAttachmentFor = async (url, label = '') => {
    const key = normalizedUrlKey(url);
    if (!key) return null;
    if (swatchCache.has(key)) return swatchCache.get(key);
    const existing = attachmentFor(url);
    if (existing?.attachment_id) {
      const attachment = { attachment_id: Number(existing.attachment_id), url: clean(existing.url) };
      swatchCache.set(key, attachment);
      return attachment;
    }
    let binary = null;
    let mimeType = null;
    let sourceUrl = null;
    const stored = imageByUrlKey.get(key) ?? null;
    if (stored?.storage_path) {
      try {
        binary = await fs.readFile(stored.storage_path);
        mimeType = clean(stored.mime_type) || 'image/jpeg';
        sourceUrl = clean(stored.source_url) || url;
      } catch { binary = null; }
    }
    if (!binary && /^https:\/\//i.test(url)) {
      try {
        const response = await fetch(url, {
          headers: { referer: 'https://detail.1688.com/', 'user-agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(45000),
        });
        if (response.ok) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 64) {
            binary = bytes;
            mimeType = clean(response.headers.get('content-type')) || 'image/jpeg';
            sourceUrl = url;
          }
        }
      } catch { binary = null; }
    }
    if (!binary) { swatchCache.set(key, null); return null; }
    try {
      const { uploaded } = await uploadVerifiedWordPressImage({
        wp, detail, index: 500 + swatchCache.size,
        binary, mimeType,
        draft: { externalId: template.external_id, styleNo: publication?.style_no ?? '', payload: { title: clean(label) || 'Swatch', images: [] } },
        image: {
          source_url: sourceUrl || url,
          image_type: 'sku', sort_order: Number(stored?.sort_order) || 0,
        },
      });
      const attachment = { attachment_id: Number(uploaded.attachment_id || uploaded.id), url: clean(uploaded.url) };
      swatchCache.set(key, attachment);
      return attachment;
    } catch {
      swatchCache.set(key, null);
      return null;
    }
  };
  const buildColours = async (content) => {
    const colours = [];
    for (const [index, colour] of (content.colours ?? []).entries()) {
      const label = colour.text || colour.source;
      const attachment = colour.thumb ? await swatchAttachmentFor(colour.thumb, label) : null;
      colours.push({
        label: colour.text || colour.source,
        value: `color-${index + 1}`,
        ...(colour.code ? { code: colour.code } : {}),
        ...(colour.source && colour.source !== (colour.text || colour.source) ? { source_label: colour.source } : {}),
        ...(attachment?.attachment_id ? { image_id: Number(attachment.attachment_id) } : {}),
      });
    }
    return colours;
  };

  // Style numbers are bound to external ids by WordPress, so a product whose
  // reviewed category changes prefix gets a freshly reserved number and the
  // sync writes it explicitly; products already matching keep their number.
  const stylePreview = async (externalId, categoryId) => wp('/wp-json/hx/v1/products/style-number', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ external_id: externalId, primary_category_id: categoryId ?? 0, reserve: false }),
  }).catch(() => null);
  const reserveStyleNumber = async (categoryId) => {
    const allocated = await wp('/wp-json/hx/v1/products/style-number', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        external_id: `hx-renumber-${crypto.randomUUID()}`, primary_category_id: categoryId ?? 0, reserve: true,
      }),
    });
    return clean(allocated?.style_no) || null;
  };
  const matchesStyleScheme = (styleNo, prefix) => {
    const value = clean(styleNo).toUpperCase();
    const schemePrefix = clean(prefix).toUpperCase();
    return Boolean(value && schemePrefix) && new RegExp(`^${schemePrefix}\\d+$`).test(value);
  };
  const resolveStyle = async ({ currentStyle, externalId, categoryId }) => {
    const current = clean(currentStyle) || null;
    if (!categoryId) return { styleNo: current, renumbered: false };
    const preview = await stylePreview(externalId, categoryId);
    const prefix = clean(preview?.scheme?.prefix) || null;
    if (!prefix || matchesStyleScheme(current, prefix)) return { styleNo: current, renumbered: false };
    const reserved = await reserveStyleNumber(categoryId).catch(() => null);
    if (reserved) return { styleNo: reserved, renumbered: true, prefix };
    const fallback = clean(preview?.style_no) || null;
    return { styleNo: fallback || current, renumbered: false, prefix };
  };

  const buildImages = async (content, { externalId, styleNo, altText }) => {
    let rows = [];
    for (const imageId of content.imageRefs?.imageIds ?? []) {
      const image = detailImages.get(String(imageId));
      if (image) rows.push(image);
    }
    // URL-only assigned images become usable once downloaded (matched by URL).
    for (const url of content.imageRefs?.imageUrls ?? []) {
      const match = (detail?.images ?? [])
        .find((image) => normalizedUrlKey(image.source_url) === normalizedUrlKey(url));
      if (match && !rows.some((row) => String(row.id) === String(match.id))) rows.push(match);
    }
    // Content dedupe within this split product (exact sha + near dHash/pHash):
    // nothing duplicated is published even when the source mixed it in.
    let deduped = 0;
    try {
      const outcome = await dedupeImagesByHash(rows.map((image) => ({
        id: String(image.id),
        sourceUrl: image.source_url ?? null,
        contentSha256: image.content_sha256 ?? null,
        storagePath: image.storage_path ?? null,
      })));
      const keptIds = new Set(outcome.kept.map((entry) => String(entry.id)));
      deduped = outcome.removed.length;
      rows = rows.filter((row) => keptIds.has(String(row.id)));
    } catch { /* keep the list as-is when hashing fails */ }
    const images = [];
    const skipped = [];
    const altFixes = [];
    let index = 0;
    for (const image of rows) {
      const attachment = attachmentFor(image.source_url);
      if (attachment?.attachment_id) {
        images.push({
          attachment_id: Number(attachment.attachment_id), alt: altText,
          source_url: clean(image.source_url), url: clean(attachment.url),
        });
        if (clean(attachment.alt) !== altText) {
          altFixes.push({ attachmentId: Number(attachment.attachment_id), alt: altText });
        }
        index += 1;
        continue;
      }
      if (!image.storage_path) { skipped.push(String(image.id)); continue; }
      try {
        const binary = await fs.readFile(image.storage_path);
        const mimeType = clean(image.mime_type) || 'image/jpeg';
        const { uploaded } = await uploadVerifiedWordPressImage({
          wp, detail, index, binary, mimeType,
          draft: { externalId, styleNo, payload: { title: altText, images: [] } },
          image: {
            source_url: clean(image.source_url),
            image_type: clean(image.image_type) || 'gallery',
            sort_order: Number(image.sort_order) || 0,
          },
        });
        images.push({
          attachment_id: Number(uploaded.attachment_id || uploaded.id), alt: altText,
          source_url: clean(image.source_url), url: clean(uploaded.url),
        });
      } catch {
        skipped.push(String(image.id));
      }
      index += 1;
    }
    // Refresh the alt text of reused attachments so gallery copy follows the
    // reviewed product name (best-effort; a failure never blocks publishing).
    for (const fix of altFixes) {
      try {
        await wp(`/wp-json/wp/v2/media/${fix.attachmentId}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alt_text: fix.alt }),
        });
      } catch { /* keep publishing */ }
    }
    return { images, skipped, deduped };
  };

  const buildSizes = (content) => (content.sizes ?? []).map((size) => ({ label: size.text || size.source, value: size.source || size.text }));

  const buildSkuRows = (content, styleNo) => {
    const used = new Map();
    return (content.skus ?? []).map((sku, index) => {
      const segments = [sku.code, sku.sizeText ?? sku.size]
        .filter((value) => value !== null && value !== undefined && String(value).trim())
        .map((value) => String(value).toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
        .filter(Boolean);
      let supplierSku = styleNo && segments.length
        ? `${styleNo}-${segments.join('-')}` : (clean(sku.sku) || null);
      if (supplierSku) {
        const count = (used.get(supplierSku) ?? 0) + 1;
        used.set(supplierSku, count);
        if (count > 1) supplierSku = `${supplierSku}-${count}`;
      }
      return {
        index,
        source_sku_key: `${sku.colour ?? ''}|${sku.size ?? ''}`,
        label: sku.sizeText ?? sku.size ?? '',
        options: { Color: sku.colour ?? '', Size: sku.sizeText ?? sku.size ?? '' },
        source_options: { Color: sku.colour ?? '', Size: sku.size ?? '' },
        color: sku.colour ?? '',
        size: sku.sizeText ?? sku.size ?? '',
        source_price: sku.price ?? null,
        source_currency: clean(template.source?.currency) || 'CNY',
        source_stock: sku.stock ?? null,
        supplier_sku: supplierSku,
        available: sku.stock === null || sku.stock === undefined ? null : Number(sku.stock) > 0,
      };
    });
  };

  const sorted = [...products].sort((left, right) =>
    (right.options?.length ?? 0) - (left.options?.length ?? 0)
    || (right.imageRefs?.imageIds?.length ?? 0) - (left.imageRefs?.imageIds?.length ?? 0));
  // Stable identity across runs: the product that is already the keeper stays
  // the keeper, siblings keep the plan order (external ids and reserved style
  // numbers must never travel between products when dedupe changes counts).
  const planOrder = new Map(products.map((content, index) => [String(content.id), index]));
  const previousKeeper = products
    .find((content) => storedWp.get(String(content.id))?.role === 'keeper') ?? null;
  const keeper = previousKeeper ?? sorted[0];
  const siblings = products
    .filter((item) => item !== keeper)
    .sort((left, right) => (planOrder.get(String(left.id)) ?? 999) - (planOrder.get(String(right.id)) ?? 999));
  const results = { keeper: null, created: [], errors: [] };

  // Style numbers must stay unique per bundle; siblings also follow the post
  // they already own (reverse-mapped external ids), so a product's identity
  // never travels to another post when image counts change the sort order.
  const usedStyles = new Set();
  const postToExternalId = new Map();
  for (let slot = 0; slot < siblings.length; slot += 1) {
    const candidate = `${template.external_id}S${slot + 2}`;
    const record = await wp(`/wp-json/hx/v1/products/by-external-id/${encodeURIComponent(candidate)}`, { timeoutMs: 30000 })
      .catch(() => null);
    const postId = Number(record?.post_id);
    if (postId) postToExternalId.set(postId, candidate);
  }

  // 1) Update the original post with the keeper product.
  {
    const review = skipReview ? null : await reviewSplitProduct({
      content: keeper,
      options: optionsFor(keeper),
      currentCategoryId: template.meta?.primary_category_id ?? (template.category_ids ?? [])[0] ?? null,
      categories: allCategories,
      config,
    }).catch(() => null);
    const keeperTitle = clean(review?.title) || clean(keeper.title);
    const keeperDescription = clean(review?.description) || clean(keeper.description);
    const pickedCategory = allCategories
      .find((item) => Number(item.id) === Number(review?.categoryId)) ?? null;
    const keeperCategories = [...new Set([
      ...(pickedCategory ? [pickedCategory.id] : []),
      ...(Array.isArray(template.category_ids) ? template.category_ids : []),
    ].map(Number).filter((value) => Number.isInteger(value) && value > 0))];
    const keeperStyle = await resolveStyle({
      currentStyle: publication.style_no,
      externalId: template.external_id,
      categoryId: pickedCategory?.id ?? null,
    });
    const keeperStyleNo = keeperStyle.styleNo || publication.style_no;
    usedStyles.add(clean(keeperStyleNo).toUpperCase());
    const { images, skipped, deduped } = await buildImages(keeper, {
      externalId: template.external_id, styleNo: keeperStyleNo, altText: keeperTitle,
    });
    const colours = await buildColours(keeper);
    const { pricing: prices, sourceMin, sourceMax } = pricingFor(keeper);
    const keeperSkuRows = buildSkuRows(keeper, keeperStyleNo);
    const keeperInStock = keeperSkuRows.length > 0 && keeperSkuRows.every((row) => row.available === true);
    const payload = {
      ...template,
      external_id: template.external_id,
      style_no: keeperStyleNo,
      title: keeperTitle,
      description: keeperDescription,
      status: 'publish',
      category_ids: keeperCategories.length ? keeperCategories : (template.category_ids ?? []),
      images,
      colors: colours.length ? { default: colours[0].value, colors: colours } : null,
      sizes: (keeper.sizes ?? []).length ? { default: buildSizes(keeper)[0].label, sizes: buildSizes(keeper) } : null,
      sku_matrix: { schema_version: 1, source_currency: clean(template.source?.currency) || 'CNY', rows: keeperSkuRows },
      bulk_pricing: prices,
      meta: {
        ...(template.meta ?? {}),
        ...(pickedCategory ? { primary_category_id: String(pickedCategory.id), primary_category: pickedCategory.name } : {}),
        ...(sourceMax !== null ? {
          source_price_min: String(sourceMin ?? sourceMax), source_price_max: String(sourceMax),
        } : {}),
        style: pickedCategory?.name ?? template.meta?.style ?? '',
        sample_available: keeperInStock,
        sample_lead_time: keeperInStock ? '3 working days' : '7 to 14 working days',
        lead_time: keeperInStock ? '3 working days' : '7 to 14 working days',
        sku: keeperStyleNo, title: keeperTitle, description: keeperDescription,
      },
      source: {
        ...(template.source ?? {}),
        ...(sourceMax !== null ? { price_min: sourceMin ?? sourceMax, price_max: sourceMax } : {}),
        split_product_id: keeper.id ?? null, split_product_name: keeper.name ?? null,
      },
    };
    const synced = await wp('/wp-json/hx/v1/products/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 120000,
    });
    results.keeper = {
      productId: keeper.id, title: keeperTitle, description: keeperDescription, styleNo: keeperStyleNo,
      renumbered: keeperStyle.renumbered === true, externalId: template.external_id,
      postId: synced.post_id ?? publication.wp_post_id, url: synced.permalink ?? publication.wp_url,
      status: synced.status ?? 'publish', imageCount: images.length, skippedImages: skipped.length,
      dedupedImages: deduped,
      payload,
    };
  }

  // 2) Create the remaining split products as drafts.
  for (const [index, content] of siblings.entries()) {
    try {
      const previousWp = storedWp.get(String(content.id)) ?? null;
      const storedPostId = Number(previousWp?.postId) || null;
      const externalId = clean(previousWp?.externalId)
        || (storedPostId ? postToExternalId.get(storedPostId) : null)
        || `${template.external_id}S${index + 2}`;
      const review = skipReview ? null : await reviewSplitProduct({
        content,
        options: optionsFor(content),
        currentCategoryId: previousWp?.categoryId ?? null,
        categories: allCategories,
        config,
      }).catch(() => null);
      const title = clean(review?.title) || clean(content.title);
      const description = clean(review?.description) || clean(content.description);
      let categoryId = Number(review?.categoryId) || Number(previousWp?.categoryId) || null;
      if (!categoryId && skipReview) categoryId = Number(template.meta?.primary_category_id) || null;
      if (!categoryId) categoryId = await pickSplitCategory({ content, categories: allCategories, config });
      // Keep an already matching style number; otherwise reserve a fresh one
      // from the reviewed category so style, category and collection align.
      const storedStyle = clean(previousWp?.styleNo) || null;
      const resolvedStyle = await resolveStyle({
        currentStyle: storedStyle, externalId, categoryId,
      }).catch(() => null);
      let styleNo = clean(resolvedStyle?.styleNo) || storedStyle || null;
      if (styleNo && usedStyles.has(styleNo.toUpperCase())) {
        // A number already used by the keeper (or an earlier sibling) would
        // duplicate the reservation — take a fresh one from this category.
        const reallocated = await reserveStyleNumber(categoryId).catch(() => null);
        if (reallocated) styleNo = reallocated;
      }
      if (styleNo) usedStyles.add(styleNo.toUpperCase());
      if (!styleNo) {
        const allocate = (primaryCategoryId) => wp('/wp-json/hx/v1/products/style-number', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            external_id: externalId,
            primary_category_id: primaryCategoryId ?? 0,
            reserve: true,
          }),
        });
        let allocated;
        try {
          allocated = await allocate(categoryId);
        } catch (error) {
          // Some merchandising categories have no approved style-number prefix:
          // fall back to the category the original (published) product uses.
          const fallbackId = Number(template.meta?.primary_category_id) || 0;
          if (!fallbackId || Number(categoryId) === fallbackId) throw error;
          allocated = await allocate(fallbackId);
          categoryId = fallbackId;
        }
        styleNo = clean(allocated.style_no);
        if (!styleNo) throw new Error('Style number allocation returned nothing.');
      }
      const { images, skipped, deduped } = await buildImages(content, {
        externalId, styleNo, altText: title,
      });
      const colours = await buildColours(content);
      const sizes = buildSizes(content);
      const { pricing: prices, sourceMin: siblingMin, sourceMax: siblingMax } = pricingFor(content);
      const categoryName = allCategories.find((item) => Number(item.id) === Number(categoryId))?.name ?? clean(template.meta?.primary_category);
      const siblingSkuRows = buildSkuRows(content, styleNo);
      const siblingInStock = siblingSkuRows.length > 0 && siblingSkuRows.every((row) => row.available === true);
      const payload = {
        ...template,
        external_id: externalId,
        style_no: styleNo,
        title,
        description,
        status: 'draft',
        category_ids: categoryId ? [categoryId] : (template.category_ids ?? []),
        images,
        colors: colours.length ? { default: colours[0].value, colors: colours } : null,
        sizes: sizes.length ? { default: sizes[0].label, sizes } : null,
        sku_matrix: { schema_version: 1, source_currency: clean(template.source?.currency) || 'CNY', rows: siblingSkuRows },
        bulk_pricing: prices,
        meta: {
          ...(template.meta ?? {}), sku: styleNo, title, description,
          primary_category_id: categoryId ? String(categoryId) : (template.meta?.primary_category_id ?? ''),
          primary_category: categoryName ?? template.meta?.primary_category ?? '',
          style: categoryName ?? template.meta?.style ?? '',
          sample_available: siblingInStock,
          sample_lead_time: siblingInStock ? '3 working days' : '7 to 14 working days',
          lead_time: siblingInStock ? '3 working days' : '7 to 14 working days',
          ...(siblingMax !== null ? {
            source_price_min: String(siblingMin ?? siblingMax), source_price_max: String(siblingMax),
          } : {}),
        },
        source: {
          ...(template.source ?? {}),
          ...(siblingMax !== null ? { price_min: siblingMin ?? siblingMax, price_max: siblingMax } : {}),
          split_product_id: content.id ?? null, split_product_name: content.name ?? null,
        },
      };
      const synced = await wp('/wp-json/hx/v1/products/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 120000,
      });
      results.created.push({
        productId: content.id, title, description, styleNo, externalId, categoryId, categoryName,
        postId: synced.post_id ?? null, url: synced.permalink ?? null, status: synced.status ?? 'draft',
        imageCount: images.length, skippedImages: skipped.length, dedupedImages: deduped,
      });
    } catch (error) {
      results.errors.push({ productId: content.id, message: String(error?.message || error).slice(0, 200) });
    }
  }
  return results;
}

export async function updateWordPressProductStyleNumber({ publication, styleNo, config, optionOverrides = [] }) {
  const wp = wordpressClient(config);
  // Repair paths replay the saved payload verbatim, so re-apply the manual
  // option overrides here: a payload saved before an override existed would
  // otherwise write the captured label back to WordPress.
  const payload = applyOptionOverridesToPayload(structuredClone(publication?.payload ?? {}), optionOverrides);
  if (!payload.external_id) throw new Error('The saved WordPress publication has no external ID.');
  payload.style_no = clean(styleNo);
  payload.meta = { ...(payload.meta ?? {}), sku: payload.style_no };
  const result = await wp('/wp-json/hx/v1/products/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  });
  return { payload, wordpress: result };
}

export async function prepareWordPressProductDraft({
  detail, translation, options = {}, config, reserveStyleNumber = false, optionOverrides = [],
}) {
  const wp = wordpressClient(config);
  const taxonomies = await wp('/wp-json/hx/v1/products/taxonomies');
  const needsCategoryModel = !(Array.isArray(options.categoryIds) && options.categoryIds.length)
    || clean(options.categoryMode) === 'auto' || clean(options.categoryMode) === 'primary_only';
  const tagMode = clean(options.tagMode);
  const needsTagModel = tagMode === 'auto' || (tagMode !== 'manual'
    && !(Array.isArray(options.tagIds) && options.tagIds.length)
    && !(Array.isArray(options.tags) && options.tags.length));
  const needsMaterialModel = !clean(options.material);
  const merchandising = (needsCategoryModel || needsTagModel || needsMaterialModel)
    ? await analyzeProductMerchandising({ detail, translation, taxonomies, config: {
      apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
      complexModel: config.complexModel, storagePath: config.storagePath,
      reasoningEffort: config.reasoningEffort,
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
    detail, translation, options: { ...options, styleNo }, merchandising, taxonomies, optionOverrides,
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

export async function publishProductToWordPress({ detail, translation, options = {}, config, optionOverrides = [] }) {
  const draft = await prepareWordPressProductDraft({
    detail, translation, options, config, reserveStyleNumber: true, optionOverrides,
  });
  const wp = wordpressClient(config);
  const media = [];

  // Refresh mode: reuse the attachments already referenced by the stored
  // publication payload (matched by normalized source URL) and upload only
  // genuinely new images — no re-verification of unchanged media.
  const reuseByKey = new Map();
  if (options.reuseMedia === true && options.previousPayload) {
    for (const image of (options.previousPayload.images ?? [])) {
      const key = normalizedImageKey(image?.source_url);
      const attachmentId = Number(image?.attachment_id);
      if (key && Number.isInteger(attachmentId) && attachmentId > 0) {
        reuseByKey.set(key, { attachmentId, url: clean(image?.url) });
      }
    }
  }

  for (const [index, image] of draft.uploadImages.entries()) {
    const reused = reuseByKey.get(normalizedImageKey(image.source_url));
    if (reused) {
      media.push({
        sourceImageId: String(image.id), attachmentId: reused.attachmentId,
        url: reused.url, reused: true, verification: { reused: true },
      });
      continue;
    }
    if (!image.storage_path) continue;
    const absolutePath = resolveStorageFile(config.storagePath, image.storage_path);
    const binary = await fs.readFile(absolutePath);
    const mimeType = clean(image.mime_type) || 'image/jpeg';
    const { uploaded, verification, repaired } = await uploadVerifiedWordPressImage({
      wp, draft, detail, image, index, binary, mimeType,
    });
    media.push({
      sourceImageId: String(image.id),
      attachmentId: Number(uploaded.attachment_id || uploaded.id),
      url: clean(uploaded.url),
      verification,
      repaired,
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
          ...(color.code ? { code: color.code } : {}),
          ...(color.source_label ? { source_label: color.source_label } : {}),
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
  let publicationDateResult = null;
  if (result.post_id && payload.publication_date) {
    publicationDateResult = await setWordPressProductPublicationDate({
      postId: result.post_id, publicationDate: payload.publication_date, config,
    });
  }
  return { draft, payload, media, wordpress: { ...result,
    publication_date: publicationDateResult?.date_gmt || publicationDateResult?.date || payload.publication_date } };
}
