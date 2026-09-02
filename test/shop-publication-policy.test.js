import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateShopProductPolicy } from '../src/shop-publication-policy.js';

test('allows products from unrelated shops', () => {
  assert.equal(evaluateShopProductPolicy([
    { domain: 'another-shop.1688.com', category: '毛衣' },
  ]).allowed, true);
});

test('allows only explicit swim cover-up categories from the Yipin shop', () => {
  assert.equal(evaluateShopProductPolicy([
    { domain: 'shop478x140nz9144.1688.com', category: '沙滩防晒服' },
  ]).allowed, true);
  assert.equal(evaluateShopProductPolicy([
    { domain: 'shop478x140nz9144.1688.com', category: '沙滩裙、沙滩套装' },
  ]).allowed, true);
});

test('rejects sweaters and other non-cover-up categories from the Yipin shop', () => {
  for (const category of ['毛衣', '女式针织衫', '大码毛衣', '运动挎包、挂包', '比基尼、分体泳衣', '']) {
    const result = evaluateShopProductPolicy([
      { domain: 'shop478x140nz9144.1688.com', category },
    ]);
    assert.equal(result.allowed, false, category);
    assert.equal(result.reason, 'source_category_is_not_swim_coverup');
  }
});
