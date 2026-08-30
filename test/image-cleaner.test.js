import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAuditableGalleryImages } from '../src/image-cleaner.js';

test('saved Gallery audits preserve display order and exclude SKU/detail images', () => {
  const selected = selectAuditableGalleryImages([
    { id: 4, image_type: 'sku', sort_order: 0 },
    { id: 3, image_type: 'gallery', sort_order: 2 },
    { id: 1, image_type: 'main', sort_order: 0 },
    { id: 5, image_type: 'detail', sort_order: 0 },
    { id: 2, image_type: 'gallery', sort_order: 1 },
  ]);
  assert.deepEqual(selected.map((image) => image.id), [1, 2, 3]);
});
