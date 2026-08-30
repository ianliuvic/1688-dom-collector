import assert from 'node:assert/strict';
import test from 'node:test';
import { is1688ShopUrl } from '../src/collector.js';

test('recognizes named and generated 1688 shop subdomains without treating detail services as shops', () => {
  assert.equal(is1688ShopUrl('https://rongfeidi.1688.com/'), true);
  assert.equal(is1688ShopUrl('https://shop1442128638027.1688.com/page/offerlist.htm'), true);
  assert.equal(is1688ShopUrl('https://detail.1688.com/offer/1000000000000.html'), false);
  assert.equal(is1688ShopUrl('https://air.1688.com/'), false);
});
