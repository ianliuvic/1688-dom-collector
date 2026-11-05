import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionPricingFor } from '../src/selection-pricing.js';

test('builds the fixed 1 pc / 50+ Selection price rule', () => {
  const pricing = selectionPricingFor(45);
  assert.ok(pricing);
  assert.equal(pricing.priceMin, 7.69);
  assert.equal(pricing.priceMax, 9.23);
  assert.equal(pricing.moq, 50);
  assert.deepEqual(pricing.priceTiers, [
    { label: '50+ pcs', minQuantity: 50, maxQuantity: null, price: 7.69, sortOrder: 0 },
  ]);
  assert.deepEqual(pricing.pricingRule.tiers, [
    { label: '50+ pcs', minQuantity: 50, maxQuantity: null, cnyMarkup: 5, price: 7.69 },
  ]);
  assert.equal(pricing.pricingRule.sampleStartMarkupCny, 15);
  assert.equal(pricing.pricingRule.bulkMarkupCny, 5);
});

test('rounds the Selection one-piece and 50+ prices to cents', () => {
  const pricing = selectionPricingFor(23);
  assert.equal(pricing.priceMin, 4.31);
  assert.equal(pricing.priceMax, 5.85);
});

test('does not invent pricing without a positive 1688 source maximum', () => {
  assert.equal(selectionPricingFor(0), null);
  assert.equal(selectionPricingFor(null), null);
  assert.equal(selectionPricingFor('not-a-price'), null);
});
