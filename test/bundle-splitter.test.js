import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRemovedSkus } from '../src/bundle-splitter.js';

test('applyRemovedSkus drops a variant by skuId and removes its orphaned size', () => {
  const product = {
    skus: [
      { sku: 'SWOP515S1-ORNG-M', skuId: '101', colour: '橘色连体', size: 'M', sizeText: 'M' },
      { sku: 'SWOP515S1-ORNG-L', skuId: '102', colour: '橘色连体', size: 'L', sizeText: 'L' },
      { sku: 'SWOP515S1-ORNG-ONE-SIZE', skuId: '103', colour: '橘色连体', size: '均码', sizeText: 'One Size' },
    ],
    sizes: [
      { source: 'M', text: 'M' },
      { source: 'L', text: 'L' },
      { source: '均码', text: 'One Size' },
    ],
  };
  applyRemovedSkus(product, [{
    skuId: '103', sku: 'SWOP515S1-ORNG-ONE-SIZE', colour: '橘色连体', size: '均码',
  }]);
  assert.deepEqual(product.skus.map((sku) => sku.sku), ['SWOP515S1-ORNG-M', 'SWOP515S1-ORNG-L']);
  assert.deepEqual(product.sizes.map((size) => size.source), ['M', 'L']);
});

test('applyRemovedSkus matches by colour+size when ids are missing and keeps shared sizes', () => {
  const product = {
    skus: [
      { sku: 'A-BLK-M', skuId: null, colour: '黑', size: 'M', sizeText: 'M' },
      { sku: 'A-BLK-L', skuId: null, colour: '黑', size: 'L', sizeText: 'L' },
      { sku: 'A-YEL-M', skuId: null, colour: '黄', size: 'M', sizeText: 'M' },
    ],
    sizes: [{ source: 'M', text: 'M' }, { source: 'L', text: 'L' }],
  };
  applyRemovedSkus(product, [{ skuId: null, sku: null, colour: '黑', size: 'L' }]);
  assert.deepEqual(product.skus.map((sku) => sku.sku), ['A-BLK-M', 'A-YEL-M']);
  assert.deepEqual(product.sizes.map((size) => size.source), ['M']);
});

test('applyRemovedSkus is a no-op without removals', () => {
  const product = { skus: [{ sku: 'A', colour: 'c', size: 'M' }], sizes: [{ source: 'M', text: 'M' }] };
  applyRemovedSkus(product, []);
  assert.equal(product.skus.length, 1);
  assert.equal(product.sizes.length, 1);
});
