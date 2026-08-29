import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSkuRules } from '../src/sku-auditor.js';

test('flags availability language used as variant values', () => {
  const result = auditSkuRules({
    skuDimensions: [{ name: '颜色', values: ['黑色现货', '联系客服'] }],
    skuOptions: [{ text: '黑色现货', image: null }, { text: '联系客服', image: null }],
  });
  assert.ok(result.warnings.some((item) => item.code === 'availability_used_as_option'));
  assert.ok(result.warnings.some((item) => item.code === 'availability_used_as_variant_name'));
});

test('accepts ordered common sizes including numbered XL notation', () => {
  const result = auditSkuRules({ skuDimensions: [{ name: '尺码', values: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'] }] });
  assert.equal(result.dimensions[0].outOfOrder, false);
  assert.deepEqual(result.dimensions[0].nonstandardSizes, []);
});

test('flags unusual ordering and nonstandard size labels', () => {
  const result = auditSkuRules({ skuDimensions: [{ name: 'Size', values: ['L', 'M', '拍大一码'] }] });
  assert.ok(result.warnings.some((item) => item.code === 'nonstandard_size_names'));
  assert.deepEqual(result.dimensions[0].nonstandardSizes, ['拍大一码']);
});

test('flags empty names, missing variant images, and incomplete rows', () => {
  const result = auditSkuRules({
    skuDimensions: [{ name: '', values: ['', '蓝色'] }],
    skuOptions: [{ text: '', image: null }, { text: '蓝色', image: null }],
    skuRows: [{ options: {}, price: null, stock: null }],
  });
  const codes = new Set(result.warnings.map((item) => item.code));
  assert.ok(codes.has('missing_dimension_name'));
  assert.ok(codes.has('empty_option_name'));
  assert.ok(codes.has('all_variant_images_missing'));
  assert.ok(codes.has('incomplete_sku_row'));
});
