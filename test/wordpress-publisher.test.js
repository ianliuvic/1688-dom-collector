import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWordPressProductDraft, buildWearHongxiuPricing,
  get1688ArrivalDate, normalizePublicationDate,
  refreshWordPressProductPricingPayload } from '../src/wordpress-publisher.js';

const detail = {
  id: '1', offer_id: '1068935307931', canonical_url: 'https://detail.1688.com/offer/1068935307931.html',
  currency: 'CNY', price_min: '23.50', price_max: '23.50', moq: null,
  seller_name: '兴城市沐风制衣厂', seller_url: 'https://example.1688.com/', last_crawled_at: '2026-08-29T00:00:00Z',
  first_seen_at: '2026-08-28T00:00:00Z', publication_date: '2025-11-05T01:08:00Z',
  publication_date_source: '1688_listing_time',
  raw_data: { gallery: { source: 'exact_dom_gallery', complete: true, imageCount: 3 } },
  images: [
    { id: '1', image_type: 'main', sort_order: 0, source_url: 'https://img/1.webp', storage_path: '/app/storage/product-images/1/1.webp', mime_type: 'image/webp' },
    { id: '2', image_type: 'gallery', sort_order: 1, source_url: 'https://img/2.webp', storage_path: '/app/storage/product-images/1/2.webp', mime_type: 'image/webp' },
    { id: '3', image_type: 'gallery', sort_order: 2, source_url: 'https://img/logo.png', storage_path: '/app/storage/product-images/1/logo.png', mime_type: 'image/png' },
  ],
  skus: [
    { sku_key: 'S', sku_text: 'S', price: '23.50', stock: '9999', option_data: { Size: 'S', Color: '图片色' } },
    { sku_key: 'M', sku_text: 'M', price: '23.50', stock: '0', option_data: { Size: 'M', Color: '图片色' } },
  ],
};

const translation = {
  id: '2', title: "Women's Halter Triangle Bikini Two-Piece Set", description: 'Description.',
  seller_name: 'Xingcheng Mufeng Garment Factory',
  attributes: [{ name: 'Item No.', value: 'RL26010840' }, { name: 'Fabric Composition', value: 'Polyester' }],
  sku_dimensions: [{ name: 'Color', values: ['As Picture'] }, { name: 'Size', values: ['S', 'M'] }],
  sku_rows: [
    { skuKey: 'S', skuText: 'S', options: { Size: 'S', Color: 'As Picture' } },
    { skuKey: 'M', skuText: 'M', options: { Size: 'M', Color: 'As Picture' } },
  ],
  sku_options: [{ dimensionName: 'Color', text: 'As Picture', imageUrl: 'https://img/sku.webp' }],
  image_sources: [{ imageId: '1' }, { imageId: '2' }],
};

test('builds a priced wearhongxiu payload plus source SKU matrix', () => {
  const result = buildWordPressProductDraft({ detail, translation,
    options: { status: 'publish', styleNo: 'SWBK142', categoryIds: [35], primaryCategoryId: 35, tags: ['Halter Neck'] },
    taxonomies: { categories: [{ id: 35, name: 'Bikini Set' }] } });
  assert.equal(result.payload.external_id, '1688:1068935307931');
  assert.equal(result.payload.style_no, 'SWBK142');
  assert.equal(result.payload.status, 'publish');
  assert.equal(result.payload.publication_date, '2025-11-05T01:08:00.000Z');
  assert.equal(result.payload.source.publication_date_source, '1688_listing_time');
  assert.deepEqual(result.payload.category_ids, [35]);
  assert.equal(result.payload.images.length, 3);
  assert.equal(result.payload.images.some((image) => image.source_url.includes('logo')), true);
  assert.deepEqual(result.payload.sizes.sizes.map((size) => size.value), ['S', 'M']);
  assert.equal(result.payload.colors.colors[0].label, 'As Picture');
  assert.equal(result.payload.sku_matrix.rows[0].source_stock, 9999);
  assert.equal(result.payload.sku_matrix.rows[1].available, false);
  assert.deepEqual(result.payload.bulk_pricing.tiers.map((tier) => tier.price), [6.69, 5.92, 5.15]);
  assert.equal(result.payload.meta.sample_price, '50.00');
  assert.equal(result.payload.meta.sample_available, false);
  assert.equal(result.payload.meta.bulk_lead_time, '~28 days');
  assert.equal(result.payload.meta.material, 'Polyester');
  assert.equal(result.payload.meta.fabric_weight, '200gsm');
  assert.equal(result.payload.meta.customization, 'Yes');
  assert.equal(result.payload.meta.style, 'Bikini Set');
  assert.equal(result.payload.meta.source_currency, 'CNY');
  assert.equal(result.payload.meta.source_price_min, 23.5);
});

test('normalizes valid source dates and rejects invalid values', () => {
  assert.equal(normalizePublicationDate('2025-11-05T01:08:00Z'), '2025-11-05T01:08:00.000Z');
  assert.equal(normalizePublicationDate('not-a-date'), '');
});

test('uses only an official 1688 listing time for the New Arrivals date', () => {
  assert.equal(get1688ArrivalDate(detail), '20251105');
  assert.equal(get1688ArrivalDate({ ...detail, publication_date_source: 'first_seen_at' }), '');
  assert.equal(get1688ArrivalDate({ ...detail, publication_date: null }), '');
  const result = buildWordPressProductDraft({ detail, translation,
    options: { styleNo: 'SWBK999', categoryIds: [11], primaryCategoryId: 11, tagIds: [] },
    taxonomies: { categories: [{ id: 11, name: 'Bikini Set' }] } });
  assert.equal(result.payload.meta.arrival_date, '20251105');
});

test('maps each color to its own saved SKU image without adding swatches to the Gallery', () => {
  const variantDetail = {
    ...detail,
    images: [...detail.images,
      { id: '4', image_type: 'sku', sort_order: 0, source_url: 'https://img/black.jpg', storage_path: '/app/storage/product-images/1/black.jpg', mime_type: 'image/jpeg' },
      { id: '5', image_type: 'sku', sort_order: 1, source_url: 'https://img/blue.jpg', storage_path: '/app/storage/product-images/1/blue.jpg', mime_type: 'image/jpeg' }],
  };
  const variantTranslation = {
    ...translation,
    sku_dimensions: [{ name: 'Color', values: ['Black', 'Blue'] }, { name: 'Size', values: ['S', 'M'] }],
    sku_options: [
      { dimensionName: 'Color', text: 'Black', imageUrl: 'https://img/black.jpg' },
      { dimensionName: 'Color', text: 'Blue', imageUrl: 'https://img/blue.jpg' },
    ],
  };
  const result = buildWordPressProductDraft({ detail: variantDetail, translation: variantTranslation,
    options: { status: 'publish', styleNo: 'SWBK150', categoryIds: [35], primaryCategoryId: 35 },
    taxonomies: { categories: [{ id: 35, name: 'Bikini Set' }] } });
  assert.deepEqual(result.payload.colors.colors.map((color) => color.image_source_id), ['4', '5']);
  assert.equal(result.publishingImages.length, 3);
  assert.deepEqual(result.swatchImages.map((image) => image.id), ['4', '5']);
  assert.equal(result.uploadImages.length, 5);
});

test('can restrict an emergency WordPress update to the trusted main image', () => {
  const result = buildWordPressProductDraft({
    detail,
    translation,
    taxonomies: { categories: [{ id: 35, name: 'Bikini Set' }] },
    options: { status: 'publish', styleNo: 'SWBK999', imageMode: 'main_only',
      categoryIds: [35], primaryCategoryId: 35 },
  });
  assert.equal(result.payload.images.length, 1);
  assert.equal(result.payload.images[0].image_type, 'main');
});

test('blocks full-image publishing when Gallery completeness was not verified', () => {
  assert.throws(() => buildWordPressProductDraft({
    detail: { ...detail, raw_data: { gallery: { complete: false } } },
    translation,
    taxonomies: { categories: [{ id: 35, name: 'Bikini Set' }] },
    options: { status: 'publish', styleNo: 'SWBK998', categoryIds: [35], primaryCategoryId: 35 },
  }), /complete, verified 1688 product Gallery/);
});

test('uses the highest source SKU price and marks retail stock only when every SKU is in stock', () => {
  const inStock = { ...detail, price_max: '20', skus: detail.skus.map((sku, index) => ({ ...sku, price: index ? '25' : '23.5', stock: '2' })) };
  const result = buildWordPressProductDraft({ detail: inStock, translation,
    options: { styleNo: 'SWBK143', categoryIds: [35], primaryCategoryId: 35 },
    taxonomies: { categories: [{ id: 35, name: 'Bikini Set' }] } });
  assert.equal(buildWearHongxiuPricing(inStock).source_max_price, 25);
  assert.equal(result.payload.meta.sample_available, true);
  assert.equal(result.payload.bulk_pricing.tiers[0].price, 6.92);
});

test('does not trust an unverified global page price over exact saved SKU prices', () => {
  const polluted = { ...detail, price_min: '23', price_max: '999',
    raw_data: { ...detail.raw_data, price: { min: 23, max: 999, verified: false } },
    skus: detail.skus.map((sku) => ({ ...sku, price: '27' })) };
  const pricing = buildWearHongxiuPricing(polluted);
  assert.equal(pricing.source_max_price, 27);
  assert.deepEqual(pricing.tiers.map((tier) => tier.price), [7.23, 6.46, 5.69]);
});

test('refreshes every saved source-price field during a price-only WordPress repair', () => {
  const existing = {
    external_id: '1688:example', title: 'Example',
    bulk_pricing: { source_max_price: 999 },
    meta: { source_price_min: 1, source_price_max: 999, material: 'Polyester' },
    source: { price_min: 1, price_max: 999, platform: '1688' },
  };
  const repairedDetail = {
    ...detail, price_min: '26', price_max: '28',
    raw_data: { price: { verified: true } },
    skus: detail.skus.map((sku) => ({ ...sku, price: '28' })),
  };
  const payload = refreshWordPressProductPricingPayload(existing, repairedDetail);
  assert.equal(payload.bulk_pricing.source_max_price, 28);
  assert.equal(payload.meta.source_price_min, 26);
  assert.equal(payload.meta.source_price_max, 28);
  assert.equal(payload.meta.material, 'Polyester');
  assert.equal(payload.source.price_min, 26);
  assert.equal(payload.source.price_max, 28);
  assert.equal(payload.source.platform, '1688');
});

test('requires an allocated wearhongxiu style number instead of reusing the 1688 item number', () => {
  assert.throws(() => buildWordPressProductDraft({ detail, translation,
    options: { categoryIds: [35], primaryCategoryId: 35 },
    taxonomies: { categories: [{ id: 35, name: 'Bikini Set' }] } }),
  /style number allocation/);
});
