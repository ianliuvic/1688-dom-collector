import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWordPressProductDraft } from '../src/wordpress-publisher.js';

const detail = {
  id: '1', offer_id: '1068935307931', canonical_url: 'https://detail.1688.com/offer/1068935307931.html',
  currency: 'CNY', price_min: '23.50', price_max: '23.50', moq: null,
  seller_name: '兴城市沐风制衣厂', seller_url: 'https://example.1688.com/', last_crawled_at: '2026-08-29T00:00:00Z',
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
  sku_options: [{ text: 'As Picture', imageUrl: 'https://img/2.webp' }],
  image_sources: [{ imageId: '1' }, { imageId: '2' }],
};

test('builds a backward-compatible product payload plus source SKU matrix', () => {
  const result = buildWordPressProductDraft({ detail, translation, options: { status: 'publish', categoryIds: [35] } });
  assert.equal(result.payload.external_id, '1688:1068935307931');
  assert.equal(result.payload.style_no, 'RL26010840');
  assert.equal(result.payload.status, 'publish');
  assert.deepEqual(result.payload.category_ids, [35]);
  assert.equal(result.payload.images.length, 2);
  assert.equal(result.payload.images.some((image) => image.source_url.includes('logo')), false);
  assert.deepEqual(result.payload.sizes.sizes.map((size) => size.value), ['S', 'M']);
  assert.equal(result.payload.colors.colors[0].label, 'As Picture');
  assert.equal(result.payload.sku_matrix.rows[0].source_stock, 9999);
  assert.equal(result.payload.sku_matrix.rows[1].available, false);
  assert.equal(result.payload.bulk_pricing, null);
  assert.equal(result.payload.meta.source_currency, 'CNY');
  assert.equal(result.payload.meta.source_price_min, 23.5);
});
