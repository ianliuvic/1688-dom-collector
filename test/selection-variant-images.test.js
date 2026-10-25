import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelectionVariantImages } from '../src/selection-variant-images.js';

test('uses the selected media image when a swatch already exists in the gallery', async () => {
  const draft = {
    title: 'Test bikini',
    media: [
      { url: 'https://cdn.example.com/yellow.jpg', visible: true },
      { url: 'https://cdn.example.com/black.jpg', visible: true },
    ],
    swatches: [
      { value: 'Yellow', imageUrl: 'https://cdn.example.com/yellow.jpg?width=400' },
      { value: 'Black', imageUrl: 'https://cdn.example.com/black-swatch.jpg' },
    ],
    variants: [
      { optionValues: { Color: 'Yellow', Size: 'S' }, imageUrl: null },
      { optionValues: { Color: 'Black', Size: 'M' }, imageUrl: null },
    ],
  };
  const result = await resolveSelectionVariantImages({ draft, config: { publicBaseUrl: 'https://collector.example.com' } });
  assert.equal(result.draft.variants[0].imageUrl, 'https://cdn.example.com/yellow.jpg');
  assert.equal(result.draft.variants[1].imageUrl, null);
  assert.equal(result.draft.swatches.find((entry) => entry.value === 'Yellow')?.imageUrl, 'https://cdn.example.com/yellow.jpg');
  assert.equal(result.matches.find((entry) => entry.color === 'Yellow')?.matchedBy, 'exact');
  assert.deepEqual(result.unresolved, ['Black']);
});

test('matches the product swatch by content hash before calling the model', async () => {
  const draft = {
    media: [{ url: 'https://cdn.example.com/gallery.jpg', contentHash: 'same-content', visible: true }],
    swatches: [{ value: 'Black', imageUrl: 'https://collector.example.com/sku.jpg' }],
    variants: [{ optionValues: { Color: 'Black', Size: 'S' }, imageUrl: null }],
  };
  const result = await resolveSelectionVariantImages({
    draft,
    sourceSwatches: [{ value: 'Black', imageUrl: 'https://collector.example.com/source-sku.jpg', contentHash: 'same-content' }],
    config: { publicBaseUrl: 'https://collector.example.com' },
  });
  assert.equal(result.draft.variants[0].imageUrl, 'https://cdn.example.com/gallery.jpg');
  assert.equal(result.draft.swatches[0].imageUrl, 'https://cdn.example.com/gallery.jpg');
  assert.equal(result.matches[0].matchedBy, 'exact');
});

test('never turns a swatch outside media into a variant image', async () => {
  const draft = {
    media: [{ url: 'https://cdn.example.com/only.jpg', visible: true }],
    swatches: [{ value: 'Red', imageUrl: 'https://cdn.example.com/red-swatch.jpg' }],
    variants: [{ optionValues: { Color: 'Red', Size: 'S' }, imageUrl: null }],
  };
  const result = await resolveSelectionVariantImages({ draft, config: { publicBaseUrl: 'https://collector.example.com' } });
  assert.equal(result.draft.variants[0].imageUrl, null);
  assert.equal(result.matches.length, 0);
});
