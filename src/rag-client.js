function clean(value = '') {
  return String(value ?? '').trim();
}

function normalizedUrl(value) {
  return clean(value).replace(/^http:/i, 'https:');
}

function uniqueBy(items, keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function translatedSkuLabels(translation) {
  const rows = Array.isArray(translation?.sku_rows) ? translation.sku_rows : [];
  return rows.map((row) => clean(row?.skuText || row?.sku_text || row?.label
    || Object.values(row?.options ?? {}).join(' / '))).filter(Boolean);
}

function sourceSkuLabels(detail) {
  return (detail?.skus ?? []).map((row) => clean(row.sku_text || row.sku_key)).filter(Boolean);
}

function skuImageEntities(detail, translation) {
  const translatedOptions = Array.isArray(translation?.sku_options) ? translation.sku_options : [];
  const labelsByIndex = new Map(translatedOptions.map((option, index) => [index,
    clean(option?.text || option?.label || option?.name)]));
  const options = Array.isArray(detail?.raw_data?.skuOptions) ? detail.raw_data.skuOptions : [];
  return uniqueBy(options.map((option, index) => ({
    sourceImageId: clean(option.id || option.value || option.skuId || `option-${index}`),
    imageUrl: normalizedUrl(option.image || option.imageUrl),
    label: labelsByIndex.get(index) || clean(option.text || option.name || option.value),
    sortOrder: index,
    metadata: { sourceOptionIndex: index, sourceOption: option },
  })).filter((item) => item.imageUrl), (item) => item.imageUrl);
}

function galleryImageEntities(detail) {
  const images = (detail?.images ?? []).filter((image) => ['main', 'gallery'].includes(image.image_type))
    .sort((left, right) => {
      if (left.image_type === 'main' && right.image_type !== 'main') return -1;
      if (right.image_type === 'main' && left.image_type !== 'main') return 1;
      return Number(left.sort_order || 0) - Number(right.sort_order || 0);
    });
  return uniqueBy(images.map((image, index) => ({
    sourceImageId: String(image.id), imageUrl: normalizedUrl(image.source_url),
    imageType: image.image_type, sortOrder: index,
    metadata: { collectorImageId: image.id, storagePath: image.storage_path || null },
  })), (item) => item.imageUrl);
}

function publishedMainImage(publication) {
  const images = Array.isArray(publication?.payload?.images) ? publication.payload.images : [];
  const first = images.find((image) => clean(image?.url));
  const url = normalizedUrl(first?.url || publication?.result?.featured_image_url);
  const id = Number(first?.attachment_id || publication?.result?.featured_media_id
    || publication?.result?.featured_media) || null;
  return { url, id };
}

export function buildRagProduct({ detail, translation = null, publication = null, active = null }) {
  if (!detail?.offer_id) throw new Error('A saved product detail with offer_id is required for RAG sync.');
  const payload = publication?.payload ?? {};
  const translatedData = translation?.translated_data ?? {};
  const title = clean(translation?.title || translatedData.title || detail.title);
  const description = clean(translation?.description || translatedData.description || detail.description);
  const attributes = Array.isArray(translation?.attributes) && translation.attributes.length
    ? translation.attributes
    : (detail.attributes ?? []).map((item) => ({ name: item.name, value: item.value }));
  const tags = Array.isArray(payload.tags) ? payload.tags : [];
  const category = clean(payload.meta?.primary_category || payload.meta?.style
    || publication?.result?.primary_category || detail.raw_data?.category);
  const galleryImages = galleryImageEntities(detail);
  const mainImage = galleryImages[0]?.imageUrl || '';
  const wpMainImage = publishedMainImage(publication);
  const wpStatus = clean(publication?.wp_status || publication?.result?.status || payload.status);
  const isActive = active == null ? Boolean(publication?.wp_post_id && wpStatus === 'publish') : Boolean(active);
  const skuLabels = translatedSkuLabels(translation);
  const sourceLabels = sourceSkuLabels(detail);
  return {
    canonicalProductId: `1688:${detail.offer_id}`,
    sourcePlatform: '1688', sourceProductId: String(detail.offer_id),
    productDetailId: Number(detail.id), wpPostId: Number(publication?.wp_post_id) || null,
    wpImageId: wpMainImage.id,
    styleNo: clean(publication?.style_no || payload.style_no), title, description, category,
    wpUrl: clean(publication?.wp_url), wpImageUrl: wpMainImage.url,
    mainImageUrl: mainImage, active: isActive, attributes, tags,
    skuText: skuLabels.length ? skuLabels : sourceLabels,
    galleryImages,
    skuImages: skuImageEntities(detail, translation),
    metadata: {
      sourceUrl: clean(detail.canonical_url || detail.source_url), sellerName: clean(detail.seller_name),
      sourceTitle: clean(detail.title), sourceDescription: clean(detail.description),
      currency: clean(detail.currency), priceMin: detail.price_min, priceMax: detail.price_max,
      moq: detail.moq, stockTotal: (detail.skus ?? []).reduce((sum, sku) => sum + (Number(sku.stock) || 0), 0),
      attributes, tags, wordpressStatus: wpStatus || null,
      wpMainImageUrl: wpMainImage.url || null,
      wpMainImageId: wpMainImage.id,
      imageAudit: detail.latestImageAudit?.summary ?? null,
      skuAudit: detail.latestSkuAudit?.summary ?? null,
      lastCrawledAt: detail.last_crawled_at,
    },
  };
}

async function requestWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(180000) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

export function createRagClient(config) {
  const baseUrl = clean(config.productsRagApiUrl).replace(/\/+$/, '');
  const token = clean(config.productsRagAdminToken);
  const enabled = Boolean(baseUrl && token);
  function headers() {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
  return {
    enabled,
    async upsert(product, { force = false } = {}) {
      if (!enabled) throw new Error('Products RAG integration is not configured.');
      return requestWithRetry(`${baseUrl}/api/products_rag/admin/products/upsert`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ product, force }),
      });
    },
    async deactivate({ canonicalProductId, sourceProductId }) {
      if (!enabled) throw new Error('Products RAG integration is not configured.');
      return requestWithRetry(`${baseUrl}/api/products_rag/admin/products/deactivate`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ canonicalProductId, sourceProductId, sourcePlatform: '1688' }),
      });
    },
    async findSimilarProducts({ sourceProductId, title, imageUrls, topK = 10, minScore = 0.78 }) {
      if (!enabled) throw new Error('Products RAG integration is not configured.');
      return requestWithRetry(`${baseUrl}/api/products_rag/admin/products/similar`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ sourcePlatform: '1688', sourceProductId, title,
          imageUrls, topK, minScore }),
      });
    },
  };
}
