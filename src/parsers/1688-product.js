const MAX_IMAGES = 100;
const MAX_SKU_ROWS = 500;
const MAX_ATTRIBUTES = 100;

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function unique(values, limit = Infinity) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function numberFrom(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeImageUrl(value, baseUrl) {
  if (!value || typeof value !== 'string' || value.startsWith('data:')) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value, baseUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.searchParams.delete('x-oss-process');
    return url.href.replace(/_(?:\d+x\d+|sum|\.webp)(?=\.(?:jpg|jpeg|png|webp)(?:$|\?))/i, '');
  } catch {
    return null;
  }
}

function normalizeTier(tier) {
  const minQuantity = numberFrom(tier.minQuantity ?? tier.beginAmount ?? tier.startQuantity ?? tier.range);
  const maxQuantity = numberFrom(tier.maxQuantity ?? tier.endAmount ?? tier.endQuantity);
  const price = numberFrom(tier.price ?? tier.value ?? tier.priceText);
  return price === null ? null : { minQuantity, maxQuantity, price };
}

/** Extract a deliberately bounded, normalized product record from a loaded 1688 page. */
export async function parse1688Product(page) {
  const raw = await page.evaluate(() => {
    const text = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() || '';
    const attr = (node, names) => {
      for (const name of names) {
        const value = node?.getAttribute?.(name);
        if (value) return value;
      }
      return null;
    };
    const meta = (selector) => document.querySelector(selector)?.content || null;
    const all = (selector) => Array.from(document.querySelectorAll(selector));

    const jsonLd = all('script[type="application/ld+json"]').flatMap((script) => {
      try {
        const value = JSON.parse(script.textContent);
        return Array.isArray(value) ? value : [value];
      } catch {
        return [];
      }
    });

    const assignedJson = {};
    for (const name of [
      '__NEXT_DATA__', '__INIT_DATA__', '__GLOBAL_DATA__', '__INITIAL_STATE__',
      '__PRELOADED_STATE__', '__ICE_APP_DATA__', '__pageData', 'offerData',
    ]) {
      try {
        const value = window[name];
        if (value && typeof value === 'object') assignedJson[name] = value;
      } catch { /* inaccessible globals are ignored */ }
    }

    const compact = (value, depth = 0) => {
      if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return typeof value === 'string' ? value.slice(0, 2000) : value;
      }
      if (depth >= 4) return null;
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => compact(item, depth + 1));
      const output = {};
      for (const [key, child] of Object.entries(value).slice(0, 80)) {
        output[key] = compact(child, depth + 1);
      }
      return output;
    };
    const embeddedCandidates = { prices: [], tiers: [], skuRows: [], dimensions: [], attributes: [], images: [] };
    const scanned = new WeakSet();
    const scan = (value, depth = 0, key = '') => {
      if (!value || depth > 9) return;
      if (typeof value === 'string') {
        if (/image|pic|photo/i.test(key) && embeddedCandidates.images.length < 200) {
          embeddedCandidates.images.push(value);
        }
        return;
      }
      if (typeof value !== 'object' || scanned.has(value)) return;
      scanned.add(value);
      if (Array.isArray(value)) {
        if (/price.*range|range.*price|ladder|step.*price/i.test(key)) {
          embeddedCandidates.tiers.push(...value.slice(0, 50).map(compact));
        }
        if (/sku.*(list|map|info)|product.*sku/i.test(key)) {
          embeddedCandidates.skuRows.push(...value.slice(0, 500).map(compact));
        }
        if (/sku.*prop|sku.*dimension|sale.*prop/i.test(key)) {
          embeddedCandidates.dimensions.push(...value.slice(0, 50).map(compact));
        }
        for (const item of value.slice(0, 1000)) scan(item, depth + 1, key);
        return;
      }
      for (const [childKey, childValue] of Object.entries(value).slice(0, 500)) {
        if (/^(price|minPrice|maxPrice|salePrice|promotionPrice|discountPrice)$/i.test(childKey)) {
          embeddedCandidates.prices.push(childValue);
        }
        if (/^(image|imageUrl|picUrl|mainImage|originalImage|fullPathImageURI)$/i.test(childKey)
            && typeof childValue === 'string') embeddedCandidates.images.push(childValue);
        if (/^(attributes|productAttributes|featureList)$/i.test(childKey) && Array.isArray(childValue)) {
          embeddedCandidates.attributes.push(...childValue.slice(0, 100).map(compact));
        }
        scan(childValue, depth + 1, childKey);
      }
    };
    scan(assignedJson);

    const images = all('img').map((image) => attr(image, [
      'src', 'data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload',
    ]));

    const attributes = [];
    for (const row of all([
      '[class*="attribute"] [class*="item"]', '[class*="attr"] [class*="item"]',
      '.od-pc-attribute-list > div', '.offer-attr-item', 'dl',
    ].join(','))) {
      const children = Array.from(row.children).map(text).filter(Boolean);
      if (children.length >= 2 && children[0].length <= 50) {
        attributes.push({ name: children[0].replace(/[：:]$/, ''), value: children.slice(1).join(' ') });
      } else {
        const value = text(row);
        const match = value.match(/^([^：:]{1,50})[：:]\s*(.+)$/);
        if (match) attributes.push({ name: match[1], value: match[2] });
      }
    }

    const skuOptions = all([
      '[class*="sku"] button', '[class*="sku"] [class*="item"]',
      '[class*="sku"] li', '[class*="sku"] img', '[class*="prop"] [class*="item"]',
    ].join(',')).map((node) => ({
      text: attr(node, ['title', 'alt']) || text(node),
      image: node.tagName === 'IMG' ? attr(node, ['src', 'data-src', 'data-lazy-src'])
        : attr(node.querySelector?.('img'), ['src', 'data-src', 'data-lazy-src']),
    })).filter((item) => item.text || item.image);

    const priceTexts = all('[class*="price"], [class*="Price"], [class*="amount"]')
      .map(text).filter((value) => /[¥￥]|\d+(?:\.\d+)?/.test(value)).slice(0, 100);

    return {
      url: location.href,
      canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || null,
      title: meta('meta[property="og:title"]') || document.title,
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      mainImage: meta('meta[property="og:image"]'),
      images,
      jsonLd,
      embeddedCandidates,
      attributes,
      skuOptions,
      priceTexts,
      bodyText: text(document.body).slice(0, 200000),
      sellerLinks: all('a[href*="shop.1688.com"], a[href*="company.1688.com"]')
        .map((node) => ({ name: text(node), url: node.href })).filter((item) => item.name),
    };
  });

  const offerId = new URL(raw.url).pathname.match(/\/offer\/(\d+)\.html/i)?.[1]
    ?? new URL(raw.url).searchParams.get('offerId');
  const productLd = raw.jsonLd.find((item) => {
    const type = item?.['@type'];
    return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
  }) ?? {};

  const embedded = raw.embeddedCandidates ?? {};
  const candidates = {
    prices: (embedded.prices ?? []).map(numberFrom).filter((value) => value !== null),
    tiers: (embedded.tiers ?? []).map(normalizeTier).filter(Boolean),
    skuRows: embedded.skuRows ?? [],
    dimensions: embedded.dimensions ?? [],
    attributes: embedded.attributes ?? [],
    images: embedded.images ?? [],
  };
  const seen = new WeakSet();
  function walk(value, depth = 0, key = '') {
    if (!value || depth > 9) return;
    if (typeof value === 'string') {
      if (/image|pic|photo/i.test(key)) candidates.images.push(value);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (/price.*range|range.*price|ladder|step.*price/i.test(key)) {
        for (const item of value) {
          const tier = item && typeof item === 'object' ? normalizeTier(item) : null;
          if (tier) candidates.tiers.push(tier);
        }
      }
      if (/sku.*(list|map|info)|product.*sku/i.test(key)) candidates.skuRows.push(...value);
      if (/sku.*prop|sku.*dimension|sale.*prop/i.test(key)) candidates.dimensions.push(...value);
      for (const item of value.slice(0, 1000)) walk(item, depth + 1, key);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value).slice(0, 500)) {
      if (/^(price|minPrice|maxPrice|salePrice|promotionPrice|discountPrice)$/i.test(childKey)) {
        const price = numberFrom(childValue);
        if (price !== null) candidates.prices.push(price);
      }
      if (/^(image|imageUrl|picUrl|mainImage|originalImage|fullPathImageURI)$/i.test(childKey)) {
        if (typeof childValue === 'string') candidates.images.push(childValue);
      }
      if (/^(attributes|productAttributes|featureList)$/i.test(childKey) && Array.isArray(childValue)) {
        candidates.attributes.push(...childValue);
      }
      walk(childValue, depth + 1, childKey);
    }
  }
  walk(productLd);

  const offers = productLd.offers ?? {};
  const offerList = Array.isArray(offers) ? offers : [offers];
  const ldPrices = offerList.flatMap((offer) => [offer?.price, offer?.lowPrice, offer?.highPrice])
    .map(numberFrom).filter((value) => value !== null);
  const priceValues = [...candidates.prices, ...ldPrices];
  const textPrices = raw.priceTexts.flatMap((value) =>
    [...value.matchAll(/[¥￥]\s*(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1])));
  if (!priceValues.length) priceValues.push(...textPrices);

  const bodyMoq = raw.bodyText.match(/(?:起批量|最小起订量|起订量|MOQ)\s*[：:]?\s*(\d+)/i);
  const ldImages = Array.isArray(productLd.image) ? productLd.image : [productLd.image];
  const images = unique([
    raw.mainImage, ...ldImages, ...candidates.images, ...raw.images,
  ].map((value) => normalizeImageUrl(value, raw.url)), MAX_IMAGES);

  const attributes = [...raw.attributes, ...candidates.attributes.map((item) => ({
    name: cleanText(item?.name ?? item?.key ?? item?.attributeName),
    value: cleanText(item?.value ?? item?.valueName ?? item?.attributeValue),
  }))].filter((item) => item.name && item.value);
  const attributeKeys = new Set();
  const dedupedAttributes = attributes.filter((item) => {
    const key = `${item.name}\0${item.value}`;
    if (attributeKeys.has(key)) return false;
    attributeKeys.add(key);
    return true;
  }).slice(0, MAX_ATTRIBUTES);

  const seller = raw.sellerLinks[0] ?? {};
  const normalized = {
    schemaVersion: 1,
    pageType: 'product',
    source: '1688',
    offerId: offerId || null,
    title: cleanText(productLd.name || raw.title).replace(/\s*[-–_]\s*阿里巴巴\s*$/, ''),
    description: cleanText(productLd.description || raw.description),
    canonicalUrl: raw.canonicalUrl || (offerId ? `https://detail.1688.com/offer/${offerId}.html` : raw.url),
    currency: offerList.find((offer) => offer?.priceCurrency)?.priceCurrency || 'CNY',
    price: {
      min: priceValues.length ? Math.min(...priceValues) : null,
      max: priceValues.length ? Math.max(...priceValues) : null,
      tiers: candidates.tiers.slice(0, 50),
      textCandidates: unique(raw.priceTexts, 20),
    },
    moq: bodyMoq ? Number(bodyMoq[1]) : null,
    mainImage: normalizeImageUrl(raw.mainImage || ldImages[0] || images[0], raw.url),
    images,
    videos: [],
    skuDimensions: candidates.dimensions.slice(0, 50),
    skuRows: candidates.skuRows.slice(0, MAX_SKU_ROWS),
    skuOptions: raw.skuOptions.slice(0, 200).map((item) => ({
      text: cleanText(item.text),
      image: normalizeImageUrl(item.image, raw.url),
    })),
    attributes: dedupedAttributes,
    seller: { name: cleanText(seller.name) || null, url: seller.url || null },
    parsedAt: new Date().toISOString(),
  };
  return normalized;
}
