import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalSizeRank } from '../src/variant-normalizer.js';

const sortedByRank = (values) => [...values].sort((left, right) => {
  const [kindLeft, rankLeft] = naturalSizeRank(left);
  const [kindRight, rankRight] = naturalSizeRank(right);
  return kindLeft - kindRight || rankLeft - rankRight;
});

test('kids age sizes: months precede years, ranges sort by start then end', () => {
  assert.deepEqual(
    sortedByRank(['2-3Y', '3-4Y', '9-12M', '12-18M', '18-24M']),
    ['9-12M', '12-18M', '18-24M', '2-3Y', '3-4Y'],
  );
});

test('kids age sizes: singles, equivalences and newborn labels', () => {
  assert.deepEqual(
    sortedByRank(['2Y', '6-9M', 'NB', '12M', '0-3M', '2T', '12-18M']),
    ['NB', '0-3M', '6-9M', '12M', '12-18M', '2Y', '2T'],
  );
});

test('letter and plus-size labels keep their established order', () => {
  assert.deepEqual(
    sortedByRank(['XL', 'S', '0XL', 'M', '2XL', 'XS']),
    ['XS', 'S', 'M', 'XL', '0XL', '2XL'],
  );
});

test('annotated labels rank by their base text; one-size stays late', () => {
  assert.deepEqual(
    sortedByRank(['2-3Y (90-100cm)', '18-24M', 'One Size']),
    ['18-24M', '2-3Y (90-100cm)', 'One Size'],
  );
});
