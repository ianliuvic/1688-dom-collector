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
    if (!/\.(?:jpg|jpeg|png|webp)(?:$|\?)/i.test(url.href)) return null;
    return url.href
      .replace(/_(?:\d+x\d+|sum|\.webp)(?=\.(?:jpg|jpeg|png|webp)(?:$|\?))/i, '')
      .replace(/\.(jpg|jpeg|png|webp)\.\1(?:$|\?)/i, '.$1');
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

const GALLERY_SELECTOR = '.od-gallery-list';
const GALLERY_IMAGE_SELECTOR = '.od-gallery-list img.preview-img';

/**
 * Materialize the exact 1688 product carousel before parsing it.
 *
 * The carousel is lazy rendered and may keep thumbnails outside the viewport
 * unresolved.  We scroll the carousel itself, bring every current thumbnail
 * into view, and retain URLs seen across virtualized DOM updates.  The
 * resulting snapshot is deliberately scoped to `.od-gallery-list`; no image
 * elsewhere on the page is ever considered a product Gallery candidate.
 */
export async function hydrate1688ProductGallery(page, {
  waitTimeoutMs = 12000,
  maxRounds = 10,
  stableRoundsRequired = 3,
} = {}) {
  if (!page?.locator || !page?.evaluate) {
    return { source: 'not_supported', complete: false, urls: [], reason: 'page_api_unavailable' };
  }

  const gallery = page.locator(GALLERY_SELECTOR).first();
  const attached = await gallery.waitFor({ state: 'attached', timeout: waitTimeoutMs })
    .then(() => true).catch(() => false);
  if (!attached) {
    const snapshot = { source: 'safe_fallback', complete: false, stable: false,
      urls: [], domImageCount: 0, expectedSlotCount: 0, unresolvedSlotCount: 0,
      rounds: 0, reason: 'exact_gallery_not_found' };
    await page.evaluate((value) => { window.__collectorExactGallerySnapshot = value; }, snapshot)
      .catch(() => {});
    return snapshot;
  }

  await gallery.scrollIntoViewIfNeeded().catch(() => {});
  const seen = new Map();
  let stableRounds = 0;
  let previousSignature = '';
  let last = { domImageCount: 0, expectedSlotCount: 0, unresolvedSlotCount: 0 };
  let rounds = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    rounds = round + 1;
    const metrics = await page.evaluate(({ gallerySelector, imageSelector, roundIndex }) => {
      const container = document.querySelector(gallerySelector);
      if (!container) return null;
      const scrollable = [container, ...container.querySelectorAll('*')]
        .find((node) => node.scrollHeight > node.clientHeight + 2
          || node.scrollWidth > node.clientWidth + 2) || container;
      const positions = [0, 0.25, 0.5, 0.75, 1, 1, 0.75, 0.5, 0.25, 0];
      const fraction = positions[roundIndex] ?? 0;
      scrollable.scrollTop = Math.round((scrollable.scrollHeight - scrollable.clientHeight) * fraction);
      scrollable.scrollLeft = Math.round((scrollable.scrollWidth - scrollable.clientWidth) * fraction);

      const candidate = (image) => {
        const values = [];
        for (const name of ['data-original', 'data-origin', 'data-lazy-src', 'data-src',
          'data-ks-lazyload', 'src']) {
          const value = image.getAttribute(name);
          if (value) values.push(value);
        }
        if (image.currentSrc) values.push(image.currentSrc);
        for (const value of String(image.getAttribute('srcset') || '').split(',')) {
          const url = value.trim().split(/\s+/)[0];
          if (url) values.push(url);
        }
        return values.find((value) => value && !value.startsWith('data:')
          && !/transparent|placeholder|loading/i.test(value)) || null;
      };
      const images = Array.from(document.querySelectorAll(imageSelector));
      for (const image of images) image.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const urls = images.map(candidate).filter(Boolean);
      return {
        urls,
        domImageCount: images.length,
        expectedSlotCount: images.length,
        unresolvedSlotCount: Math.max(0, images.length - urls.length),
      };
    }, { gallerySelector: GALLERY_SELECTOR, imageSelector: GALLERY_IMAGE_SELECTOR, roundIndex: round });
    if (!metrics) break;

    for (const url of metrics.urls) {
      const key = url.replace(/[?#].*$/, '')
        .replace(/_\.webp$/i, '')
        .replace(/_\d+x\d+[^/]*$/i, '');
      if (!seen.has(key)) seen.set(key, url);
    }
    last = metrics;

    const thumbnails = page.locator(GALLERY_IMAGE_SELECTOR);
    const count = Math.min(await thumbnails.count().catch(() => 0), 100);
    for (let index = 0; index < count; index += 1) {
      const thumbnail = thumbnails.nth(index);
      await thumbnail.scrollIntoViewIfNeeded().catch(() => {});
      await thumbnail.hover({ timeout: 1000 }).catch(() => {});
    }
    await page.waitForTimeout(350);

    const signature = [...seen.keys()].sort().join('\n');
    if (signature && signature === previousSignature && last.unresolvedSlotCount === 0) stableRounds += 1;
    else stableRounds = 0;
    previousSignature = signature;
    if (stableRounds >= stableRoundsRequired) break;
  }

  const snapshot = {
    source: 'exact_dom_gallery',
    complete: seen.size > 0 && stableRounds >= stableRoundsRequired && last.unresolvedSlotCount === 0,
    stable: stableRounds >= stableRoundsRequired,
    urls: [...seen.values()],
    domImageCount: last.domImageCount,
    expectedSlotCount: Math.max(last.expectedSlotCount, seen.size),
    unresolvedSlotCount: last.unresolvedSlotCount,
    rounds,
    reason: seen.size ? null : 'exact_gallery_images_unresolved',
  };
  await page.evaluate((value) => { window.__collectorExactGallerySnapshot = value; }, snapshot)
    .catch(() => {});
  return snapshot;
}

/** Extract a deliberately bounded, normalized product record from a loaded 1688 page. */
export async function parse1688Product(page) {
  const hydration = await hydrate1688ProductGallery(page).catch(() => ({
    source: 'safe_fallback', complete: false, stable: false, urls: [],
    reason: 'gallery_hydration_failed',
  }));
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
    const embeddedCandidates = {
      prices: [], tiers: [], skuRows: [], dimensions: [], attributes: [], images: [],
      sellerNames: [], sellerUrls: [],
    };
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
        if (/^(companyName|shopName|sellerName|supplierName|memberName)$/i.test(childKey)
            && typeof childValue === 'string') embeddedCandidates.sellerNames.push(childValue);
        if (/^(companyUrl|shopUrl|sellerUrl|supplierUrl)$/i.test(childKey)
            && typeof childValue === 'string') embeddedCandidates.sellerUrls.push(childValue);
        scan(childValue, depth + 1, childKey);
      }
    };
    scan(assignedJson);

    // The current 1688 detail template keeps product images in this exact
    // carousel. Never fall back to every large page image: review avatars,
    // recommendations and shop decorations can all be high resolution.
    const domImages = all('.od-gallery-list img.preview-img').map((image) => attr(image, [
      'data-original', 'data-origin', 'data-lazy-src', 'data-src',
      'data-ks-lazyload', 'src',
    ]));
    const gallerySnapshot = window.__collectorExactGallerySnapshot || null;
    const images = [...(gallerySnapshot?.urls || []), ...domImages];

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

    // SKU controls have a verified, explicit structure.  Reading every node
    // whose class merely contains "sku" or "item" also captures the whole
    // feature group, its label, child images and price/stock fragments.  That
    // produced one synthetic "all colours" option plus every real colour.
    const skuGroups = all('#skuSelection .feature-item').map((group) => {
      const dimensionName = text(group.querySelector('.feature-item-label h3'));
      const options = Array.from(group.querySelectorAll('.transverse-filter > .sku-filter-button'))
        .map((button) => ({
          dimensionName,
          text: text(button.querySelector('.label-name')) || attr(button, ['title', 'aria-label']) || '',
          image: attr(button.querySelector('img'), [
            'data-original', 'data-origin', 'data-lazy-src', 'data-src', 'src',
          ]),
        })).filter((item) => item.text);
      const rows = Array.from(group.querySelectorAll('.expand-view-list > .expand-view-item'))
        .map((row) => {
          const label = text(row.querySelector('.item-label')) || attr(row.querySelector('.item-label'), ['title']);
          const fragments = Array.from(row.querySelectorAll('.item-price-stock')).map(text).filter(Boolean);
          const priceText = fragments.find((value) => /[¥￥]\s*\d/.test(value)) || '';
          const stockText = fragments.find((value) => /库存\s*\d/.test(value)) || '';
          return { dimensionName, text: label || '', priceText, stockText };
        }).filter((item) => item.text);
      return { dimensionName, options, rows };
    }).filter((group) => group.dimensionName);
    const skuOptions = skuGroups.flatMap((group) => group.options);
    const domSkuDimensions = skuGroups.map((group) => ({
      name: group.dimensionName,
      values: group.options.length ? group.options.map((item) => item.text)
        : group.rows.map((item) => item.text),
    })).filter((dimension) => dimension.values.length);
    const domSkuRows = skuGroups.flatMap((group) => group.rows);

    const priceTexts = all('[class*="price"], [class*="Price"], [class*="amount"]')
      .map(text).filter((value) => /[¥￥]|\d+(?:\.\d+)?/.test(value)).slice(0, 100);

    return {
      url: location.href,
      canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || null,
      title: meta('meta[property="og:title"]') || document.title,
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      mainImage: meta('meta[property="og:image"]'),
      images,
      gallerySnapshot,
      jsonLd,
      embeddedCandidates,
      attributes,
      skuOptions,
      domSkuDimensions,
      domSkuRows,
      priceTexts,
      bodyText: (document.body?.innerText || '').slice(0, 200000),
      sellerLinks: all([
        'a[href*="shop.1688.com"]', 'a[href*="company.1688.com"]',
        'a[href*="winport"]', 'a[href*="contactinfo"]', 'a[href*=".1688.com/page/"]',
      ].join(','))
        .map((node) => ({ name: text(node), url: node.href })).filter((item) => item.name),
      sellerTexts: all('[class*="company"], [class*="shop-name"], [class*="supplier"]')
        .map(text).filter((value) => value && value.length <= 100),
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
  const exactGallery = raw.images.filter(Boolean);
  const normalizedImages = unique([
    raw.mainImage,
    ...(exactGallery.length ? exactGallery : ldImages),
  ].map((value) => normalizeImageUrl(value, raw.url)), MAX_IMAGES);
  const imageKeys = new Set();
  const images = normalizedImages.filter((url) => {
    const key = url.replace(/[?#].*$/, '').replace(/_\.webp$/i, '').replace(/_\d+x\d+[^/]*$/i, '');
    if (imageKeys.has(key)) return false;
    imageKeys.add(key);
    return true;
  });

  const knownAttributeNames = [
    '货号', '品牌', '面料名称', '面料成分', '里料名称', '里料成分', '产地', '适用性别',
    '适用年龄段', '图案', '风格', '款式', '适用场景', '产品类别', '颜色', '尺码',
    '是否跨境出口专供货源', '上市年份/季节', '质量等级',
  ];
  const textAttributes = knownAttributeNames.flatMap((name) => {
    const match = raw.bodyText.match(new RegExp(`(?:^|\\n)\\s*${name}\\s*[：:]?\\s*(?:\\n\\s*)?([^\\n]{1,100})`, 'm'));
    return match ? [{ name, value: cleanText(match[1]) }] : [];
  });
  const attributes = [...raw.attributes, ...textAttributes, ...candidates.attributes.map((item) => ({
    name: cleanText(item?.name ?? item?.key ?? item?.attributeName),
    value: cleanText(item?.value ?? item?.valueName ?? item?.attributeValue),
  }))].filter((item) => item.name && item.value
    && item.name.length <= 50 && item.value.length <= 300
    && !knownAttributeNames.includes(item.value)
    && !/(平台活动下价格|活动前价格|划线价格|未划线价格|同款|\*注|前述说明)/.test(item.name));
  const attributeKeys = new Set();
  const dedupedAttributes = attributes.filter((item) => {
    const key = `${item.name}\0${item.value}`;
    if (attributeKeys.has(key)) return false;
    attributeKeys.add(key);
    return true;
  }).slice(0, MAX_ATTRIBUTES);

  const genericSellerText = /^(商品|首页|店铺|公司|联系我们|联系方式|进入店铺)$/;
  const sellerLink = raw.sellerLinks.find((item) => !genericSellerText.test(cleanText(item.name)));
  const sellerText = (embedded.sellerNames ?? []).find((value) => !genericSellerText.test(cleanText(value)))
    ?? (raw.sellerTexts ?? []).find((value) => !genericSellerText.test(cleanText(value)))
    ?? sellerLink?.name;
  const seller = {
    name: cleanText(sellerText) || null,
    url: embedded.sellerUrls?.[0] ?? sellerLink?.url ?? raw.sellerLinks[0]?.url ?? null,
  };
  const inferredSkuRowsRaw = (raw.domSkuRows ?? []).flatMap((item) => {
    const price = numberFrom(item.priceText);
    const stock = numberFrom(item.stockText);
    return item.text && price !== null ? [{ skuText: cleanText(item.text), price, stock,
      dimensionName: cleanText(item.dimensionName) }] : [];
  });
  const inferredSkuRows = [...new Map(inferredSkuRowsRaw.map((row) => [
    `${row.skuText}\0${row.price}\0${row.stock}`, row,
  ])).values()];
  const sizeValues = unique(inferredSkuRows.map((row) => row.skuText), 100);
  const colorOptions = raw.skuOptions.filter((item) => /^(?:颜色|color)$/i.test(cleanText(item.dimensionName)));
  const colorValues = unique(colorOptions.map((item) => cleanText(item.text)), 100);
  const inferredDimensions = [
    ...(colorValues.length ? [{ name: 'Color', values: colorValues }] : []),
    ...(sizeValues.length ? [{ name: 'Size', values: sizeValues }] : []),
  ];
  for (const row of inferredSkuRows) {
    row.options = {
      ...(colorValues.length === 1 ? { Color: colorValues[0] } : {}),
      Size: row.skuText,
    };
  }
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
      textCandidates: unique(raw.priceTexts.filter((value) => value.length <= 120 && /[¥￥]/.test(value)), 20),
    },
    moq: bodyMoq ? Number(bodyMoq[1]) : null,
    mainImage: [raw.mainImage, ldImages[0], ...images]
      .map((value) => normalizeImageUrl(value, raw.url)).find(Boolean) ?? null,
    images,
    gallery: {
      source: raw.gallerySnapshot?.source || hydration.source || (exactGallery.length ? 'exact_dom_gallery' : 'safe_fallback'),
      complete: Boolean(raw.gallerySnapshot?.complete ?? hydration.complete),
      stable: Boolean(raw.gallerySnapshot?.stable ?? hydration.stable),
      imageCount: images.length,
      exactImageCount: exactGallery.length,
      expectedSlotCount: Number(raw.gallerySnapshot?.expectedSlotCount ?? hydration.expectedSlotCount) || 0,
      unresolvedSlotCount: Number(raw.gallerySnapshot?.unresolvedSlotCount ?? hydration.unresolvedSlotCount) || 0,
      rounds: Number(raw.gallerySnapshot?.rounds ?? hydration.rounds) || 0,
      reason: raw.gallerySnapshot?.reason || hydration.reason || null,
    },
    videos: [],
    skuDimensions: ((raw.domSkuDimensions ?? []).length ? raw.domSkuDimensions
      : candidates.dimensions.length ? candidates.dimensions : inferredDimensions).slice(0, 50),
    skuRows: (candidates.skuRows.length ? candidates.skuRows : inferredSkuRows).slice(0, MAX_SKU_ROWS),
    skuOptions: raw.skuOptions.slice(0, 200).map((item) => ({
      dimensionName: cleanText(item.dimensionName),
      text: cleanText(item.text),
      image: normalizeImageUrl(item.image, raw.url),
    })),
    attributes: dedupedAttributes,
    seller: { name: cleanText(seller.name) || null, url: seller.url || null },
    parsedAt: new Date().toISOString(),
  };
  return normalized;
}
