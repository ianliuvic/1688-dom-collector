import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateBestSellerSlots, selectBestSellers } from '../src/best-seller-selector.js';

test('allocates the requested total proportionally with a shop minimum', () => {
  const rows = allocateBestSellerSlots([
    { domain: 'large', publishedCount: 90 },
    { domain: 'medium', publishedCount: 9 },
    { domain: 'small', publishedCount: 1 },
  ], 10);
  assert.equal(rows.reduce((sum, row) => sum + row.allocation, 0), 10);
  assert.ok(rows.every((row) => row.allocation >= 1));
});

test('selects highest sales inside each shop and breaks ties by listing time', () => {
  const candidates = [
    { shop_id: 1, shop_name: 'A', domain: 'a', wp_post_id: 1, sale_quantity: 5, listing_time: '2026-01-01' },
    { shop_id: 1, shop_name: 'A', domain: 'a', wp_post_id: 2, sale_quantity: 10, listing_time: '2025-01-01' },
    { shop_id: 2, shop_name: 'B', domain: 'b', wp_post_id: 3, sale_quantity: 3, listing_time: '2025-01-01' },
    { shop_id: 2, shop_name: 'B', domain: 'b', wp_post_id: 4, sale_quantity: 3, listing_time: '2026-01-01' },
  ];
  const result = selectBestSellers(candidates, 2);
  assert.deepEqual(result.selected.map((row) => row.wp_post_id).sort((a, b) => a - b), [2, 4]);
  assert.equal(result.allocations.reduce((sum, row) => sum + row.allocation, 0), 2);
});

test('deduplicates WordPress posts before allocating', () => {
  const result = selectBestSellers([
    { shop_id: 1, shop_name: 'A', domain: 'a', wp_post_id: 1, sale_quantity: 10 },
    { shop_id: 1, shop_name: 'A', domain: 'a', wp_post_id: 1, sale_quantity: 10 },
  ], 36);
  assert.equal(result.eligiblePublished, 1);
  assert.equal(result.selected.length, 1);
});
