import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProductTranslationSource, translationSourceHash, validateProductTranslation,
} from '../src/product-translator.js';

const detail = {
  offer_id: '1069771570442', title: '新款泳衣', description: '两件套', seller_name: '测试工厂',
  raw_data: {
    skuDimensions: [{ name: '颜色', values: ['黑色', '蓝色'] }, { name: '尺码', values: ['S', 'M'] }],
    skuOptions: [{ text: '黑色', image: 'https://img/black.jpg' }],
    price: { textCandidates: ['2件起批'] },
  },
  attributes: [{ name: '面料', value: '聚酯纤维' }],
  skus: [{ sku_key: 'black-S', sku_text: '黑色 S', option_data: { 颜色: '黑色', 尺码: 'S' } }],
};

test('builds a translation source while preserving product identities', () => {
  const source = buildProductTranslationSource(detail);
  assert.equal(source.offerId, detail.offer_id);
  assert.equal(source.skuOptions[0].imageUrl, 'https://img/black.jpg');
  assert.equal(source.skuRows[0].skuKey, 'black-S');
  assert.equal(translationSourceHash(source), translationSourceHash(buildProductTranslationSource(detail)));
});

test('accepts a complete index-preserving translation', () => {
  const source = buildProductTranslationSource(detail);
  const translated = {
    title: 'New Swimsuit', description: 'Two-piece Set', sellerName: 'Test Factory',
    attributes: [{ index: 0, name: 'Fabric', value: 'Polyester' }],
    skuDimensions: [{ index: 0, name: 'Color', values: ['Black', 'Blue'] },
      { index: 1, name: 'Size', values: ['S', 'M'] }],
    skuOptions: [{ index: 0, text: 'Black', imageUrl: 'https://img/black.jpg' }],
    skuRows: [{ index: 0, skuKey: 'black-S', skuText: 'Black S', options: { Color: 'Black', Size: 'S' } }],
    priceTextCandidates: ['Minimum order: 2 pieces'],
  };
  assert.equal(validateProductTranslation(source, translated), translated);
});

test('rejects a translation that drops or changes SKU identity', () => {
  const source = buildProductTranslationSource(detail);
  const invalid = {
    title: 'New Swimsuit', description: 'Two-piece Set', sellerName: 'Test Factory',
    attributes: [{ index: 0, name: 'Fabric', value: 'Polyester' }],
    skuDimensions: [{ index: 0, name: 'Color', values: ['Black', 'Blue'] },
      { index: 1, name: 'Size', values: ['S', 'M'] }],
    skuOptions: [{ index: 0, text: 'Black', imageUrl: 'https://img/changed.jpg' }],
    skuRows: [{ index: 0, skuKey: 'changed', skuText: 'Black S', options: {} }],
    priceTextCandidates: ['Minimum order: 2 pieces'],
  };
  assert.throws(() => validateProductTranslation(source, invalid), /identity/);
});
