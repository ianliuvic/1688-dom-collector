import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductTranslationSource, selectTranslationImages, translationSourceHash,
  validateGeneratedCatalogCopy, validateProductTranslation,
} from '../src/product-translator.js';

const detail = {
  offer_id: '1069771570442', title: '新款泳衣', description: '两件套', seller_name: '测试工厂',
  raw_data: {
    skuDimensions: [{ name: '颜色', values: ['黑色', '蓝色'] }, { name: '尺码', values: ['S', 'M'] }],
    skuOptions: [{ dimensionName: '颜色', text: '黑色', image: 'https://img/black.jpg' }],
    price: { textCandidates: ['2件起批'] },
  },
  attributes: [{ name: '面料', value: '聚酯纤维' }],
  skus: [{ sku_key: 'black-S', sku_text: '黑色 S', option_data: { 颜色: '黑色', 尺码: 'S' } }],
  images: [
    { id: 2, image_type: 'gallery', sort_order: 1, source_url: 'https://img/2.jpg' },
    { id: 1, image_type: 'main', sort_order: 0, source_url: 'https://img/1.jpg' },
    { id: 3, image_type: 'sku', sort_order: 0, source_url: 'https://img/sku.jpg' },
  ],
};

const description = 'This two-piece bikini set features a triangle top with adjustable shoulder straps and a secure back tie. The coordinating bottoms have a streamlined silhouette with moderate coverage and clean edge finishing. Its balanced construction keeps the design versatile for a broad swimwear assortment.';

test('builds a translation source while preserving product identities', () => {
  const source = buildProductTranslationSource(detail);
  assert.equal(source.offerId, detail.offer_id);
  assert.equal(source.skuOptions[0].imageUrl, 'https://img/black.jpg');
  assert.equal(source.skuRows[0].skuKey, 'black-S');
  assert.equal(translationSourceHash(source), translationSourceHash(buildProductTranslationSource(detail)));
});

test('selects main and Gallery images in display order while excluding SKU images', () => {
  const images = selectTranslationImages(detail);
  assert.deepEqual(images.map((item) => item.id), [1, 2]);
});

test('accepts a complete index-preserving translation', () => {
  const source = buildProductTranslationSource(detail);
  const translated = {
    title: "Women's Tie-Back Triangle Bikini Set", description, sellerName: 'Test Factory',
    attributes: [{ index: 0, name: 'Fabric', value: 'Polyester' }],
    skuDimensions: [{ index: 0, name: 'Color', values: ['Black', 'Blue'] },
      { index: 1, name: 'Size', values: ['S', 'M'] }],
    skuOptions: [{ index: 0, dimensionName: '颜色', text: 'Black', imageUrl: 'https://img/black.jpg' }],
    skuRows: [{ index: 0, skuKey: 'black-S', skuText: 'Black S', options: { Color: 'Black', Size: 'S' } }],
    priceTextCandidates: ['Minimum order: 2 pieces'],
  };
  assert.equal(validateProductTranslation(source, translated), translated);
});

test('rejects a translation that drops or changes SKU identity', () => {
  const source = buildProductTranslationSource(detail);
  const invalid = {
    title: "Women's Tie-Back Triangle Bikini Set", description, sellerName: 'Test Factory',
    attributes: [{ index: 0, name: 'Fabric', value: 'Polyester' }],
    skuDimensions: [{ index: 0, name: 'Color', values: ['Black', 'Blue'] },
      { index: 1, name: 'Size', values: ['S', 'M'] }],
    skuOptions: [{ index: 0, dimensionName: '颜色', text: 'Black', imageUrl: 'https://img/changed.jpg' }],
    skuRows: [{ index: 0, skuKey: 'changed', skuText: 'Black S', options: {} }],
    priceTextCandidates: ['Minimum order: 2 pieces'],
  };
  assert.throws(() => validateProductTranslation(source, invalid), /identity/);
});

test('rejects keyword-stuffed titles and color or print-specific descriptions', () => {
  assert.throws(() => validateGeneratedCatalogCopy({
    title: '2027 Hot Sale Printed Bikini',
    description,
  }), /keywords/);
  assert.throws(() => validateGeneratedCatalogCopy({
    title: "Women's Tie-Back Triangle Bikini Set",
    description: `${description} It comes in a floral print.`,
  }), /color or print/);
});
