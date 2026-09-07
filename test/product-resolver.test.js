import test from 'node:test';
import assert from 'node:assert/strict';
import { localResolverLookup, parseProductResolverQuery } from '../src/product-resolver.js';

test('normalizes style numbers for indexed lookup', () => {
  const parsed = parseProductResolverQuery({ styleNo: 'skg269' }, 'https://wearhongxiu.com');
  assert.deepEqual(parsed, {
    kind: 'styleNo', value: 'SKG269', wordpressQuery: { style_no: 'skg269' },
  });
  assert.deepEqual(localResolverLookup(parsed), { styleNo: 'SKG269' });
});

test('requires exactly one identifier', () => {
  assert.throws(() => parseProductResolverQuery({}, 'https://wearhongxiu.com'), /exactly one/);
  assert.throws(() => parseProductResolverQuery({ styleNo: 'A12', wpPostId: 3 },
    'https://wearhongxiu.com'), /exactly one/);
});

test('accepts only URLs on the configured WordPress host', () => {
  const parsed = parseProductResolverQuery({ url: 'https://wearhongxiu.com/product/example/?x=1' },
    'https://wearhongxiu.com');
  assert.equal(parsed.value, 'https://wearhongxiu.com/product/example/');
  assert.throws(() => parseProductResolverQuery({ url: 'https://example.com/product/example/' },
    'https://wearhongxiu.com'), /configured WordPress site/);
});
