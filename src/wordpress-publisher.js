import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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

function selectPublishingImages(detail, translation) {
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

export function buildWordPressProductDraft({ detail, translation, options = {} }) {
  if (!detail?.id || !detail?.offer_id) throw new Error('A saved product detail with offer_id is required.');
  if (!translation?.id || !clean(translation.title)) throw new Error('An English product translation is required.');

  const attributes = translatedAttributeMap(translation);
  const sourceItemNumber = attributes.get('item no.') || attributes.get('item number') || '';
  const styleNo = clean(options.styleNo) || sourceItemNumber || `1688-${detail.offer_id}`;
  const publishingImages = selectPublishingImages(detail, translation);
  const sizeDimension = findDimension(translation, ['size', '尺码']);
  const sizes = unique(sizeDimension?.values ?? []);
  const colorOptions = buildColorOptions(detail, translation, publishingImages);
  const skuMatrix = buildSkuMatrix(detail, translation);
  const material = attributes.get('fabric composition') || attributes.get('fabric name') || '';
  const sourceCurrency = clean(detail.currency) || 'CNY';
  const externalId = `1688:${detail.offer_id}`;

  const payload = {
    external_id: externalId,
    style_no: styleNo,
    title: clean(translation.title),
    description: clean(translation.description),
    status: clean(options.status) || 'draft',
    source_updated_at: detail.last_crawled_at || '',
    category_ids: Array.isArray(options.categoryIds) ? options.categoryIds.map(Number).filter(Boolean) : [],
    tag_ids: Array.isArray(options.tagIds) ? options.tagIds.map(Number).filter(Boolean) : [],
    tags: Array.isArray(options.tags) ? unique(options.tags) : [],
    meta: {
      sku: styleNo,
      title: clean(translation.title),
      description: clean(translation.description),
      style: '',
      sample_available: false,
      sample_price: '',
      sample_lead_time: '',
      lead_time: '',
      moq: detail.moq == null ? '' : `${detail.moq} pcs`,
      bulk_lead_time: '',
      material,
      fabric_weight: '',
      customizable: false,
      customization: 'Not specified',
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
    bulk_pricing: null,
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

function resolveStorageFile(storagePath, filename) {
  const root = path.resolve(storagePath);
  const resolved = path.resolve(filename);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('Product image path is outside persistent storage.');
  }
  return resolved;
}

export async function publishProductToWordPress({ detail, translation, options = {}, config }) {
  const draft = buildWordPressProductDraft({ detail, translation, options });
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
  return { payload, media, wordpress: result };
}
