import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRagProduct } from '../src/rag-client.js';

test('builds product, ordered gallery and distinct SKU image entities for RAG', () => {
  const detail = {
    id: 42, offer_id: '1234567890123', title: '中文标题', description: '中文描述',
    currency: 'CNY', price_min: 20, price_max: 25,
    images: [
      { id: 3, image_type: 'gallery', sort_order: 1, source_url: 'http://img/2.jpg' },
      { id: 1, image_type: 'main', sort_order: 0, source_url: 'http://img/1.jpg' },
      { id: 4, image_type: 'detail', sort_order: 0, source_url: 'http://img/detail.jpg' },
    ],
    skus: [{ sku_text: '红色 / M', stock: 2 }],
    attributes: [{ name: '面料', value: '涤纶' }],
    raw_data: { skuOptions: [
      { id: 'red', text: '红色', image: 'http://img/red.jpg' },
      { id: 'red-copy', text: '红色', image: 'http://img/red.jpg' },
    ] },
  };
  const translation = {
    title: 'Ruched Bikini Set', description: 'A ruched two-piece swimsuit.',
    attributes: [{ name: 'Material', value: 'Polyester' }],
    sku_options: [{ text: 'Red' }, { text: 'Red' }], sku_rows: [{ skuText: 'Red / M' }],
  };
  const publication = { wp_post_id: 900, wp_status: 'publish', style_no: 'SWBK900',
    wp_url: 'https://wearhongxiu.com/product/example', payload: {
      meta: { primary_category: 'Bikini' }, tags: ['Ruched'], status: 'publish',
      images: [{ url: 'https://wearhongxiu.com/wp-content/uploads/SWBK900-1.webp',
        source_url: 'https://img/1.jpg', attachment_id: 901 }],
    } };

  const product = buildRagProduct({ detail, translation, publication });
  assert.equal(product.canonicalProductId, '1688:1234567890123');
  assert.equal(product.active, true);
  assert.equal(product.title, 'Ruched Bikini Set');
  assert.equal(product.mainImageUrl, 'https://img/1.jpg');
  assert.equal(product.wpImageUrl,
    'https://wearhongxiu.com/wp-content/uploads/SWBK900-1.webp');
  assert.equal(product.wpImageId, 901);
  assert.equal(product.metadata.wpMainImageUrl,
    'https://wearhongxiu.com/wp-content/uploads/SWBK900-1.webp');
  assert.deepEqual(product.galleryImages.map((item) => item.imageUrl),
    ['https://img/1.jpg', 'https://img/2.jpg']);
  assert.equal(product.skuImages.length, 1);
  assert.equal(product.skuImages[0].label, 'Red');
  assert.equal(product.metadata.stockTotal, 2);
});

test('keeps a captured but unpublished product inactive', () => {
  const product = buildRagProduct({ detail: {
    id: 7, offer_id: '1234567890', title: 'Source title', images: [], skus: [], raw_data: {},
  } });
  assert.equal(product.active, false);
  assert.equal(product.wpPostId, null);
});
