import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOptionOverridesToPayload, buildWordPressProductDraft } from '../src/wordpress-publisher.js';
import { applyOptionMapOverrides, buildOptionOverrideIndex, normalizeDimensionName,
  normalizeOptionText, resolveOptionDisplayLabel } from '../src/option-overrides.js';

const detail = {
  id: '1', offer_id: '597954281596', canonical_url: 'https://detail.1688.com/offer/597954281596.html',
  currency: 'CNY', price_min: '15', price_max: '17', moq: '50',
  seller_name: '义乌市俊毅电子商务商行', seller_url: 'https://example.1688.com/',
  first_seen_at: '2026-09-07T06:56:59Z',
  raw_data: { gallery: { source: 'exact_dom_gallery', complete: true, imageCount: 3 } },
  images: [
    { id: '1', image_type: 'main', sort_order: 0, source_url: 'https://img/1.webp', storage_path: '/app/storage/1.webp', mime_type: 'image/webp' },
    { id: '4', image_type: 'sku', sort_order: 0, source_url: 'https://img/9007.jpg', storage_path: '/app/storage/9007.jpg', mime_type: 'image/jpeg' },
  ],
  skus: [
    { sku_key: '5-6Y(110-116)', sku_text: '5-6Y(110-116)', price: '17', stock: '56',
      option_data: { Size: '5-6Y(110-116)', Color: '9007' } },
  ],
};

const translation = {
  id: '2', title: 'Two-Piece Bikini Set for Girls with Cross-Back Straps', description: 'Description.',
  attributes: [{ name: 'Fabric Composition', value: 'Polyester' }],
  sku_dimensions: [{ name: 'Color', values: ['9007'] }, { name: 'Size', values: ['5-6Y(110-116)'] }],
  sku_rows: [{ skuKey: '5-6Y(110-116)', skuText: '5-6Y(110-116)',
    options: { Size: '5-6Y(110-116)', Color: '9007' } }],
  sku_options: [{ dimensionName: 'Color', text: '9007', imageUrl: 'https://img/9007.jpg' }],
  image_sources: [{ imageId: '1' }],
};

const overrides = [{ dimension_name: 'color', source_text: '9007', display_label: 'Tropical Palm Print' }];

function build(optionOverrides, variantTranslation = translation) {
  return buildWordPressProductDraft({ detail, translation: variantTranslation, optionOverrides,
    options: { status: 'publish', styleNo: 'SKG166', categoryIds: [40], primaryCategoryId: 40 },
    taxonomies: { categories: [{ id: 40, name: "Girl's Swim" }] } });
}

test('normalizes override identity without touching other dimensions', () => {
  assert.equal(normalizeDimensionName('Color'), 'color');
  assert.equal(normalizeDimensionName('颜色'), 'color');
  assert.equal(normalizeDimensionName('color:'), 'color');
  assert.equal(normalizeDimensionName('Size'), 'size');
  assert.equal(normalizeDimensionName(''), 'color');
  assert.equal(normalizeOptionText('  9007 '), '9007');
  const index = buildOptionOverrideIndex([
    { dimension_name: 'color', source_text: '9007', display_label: 'Tropical Palm Print' },
    { dimension_name: 'size', source_text: '9007', display_label: 'Not A Color' },
    { dimension_name: 'color', source_text: 'same', display_label: 'Same' },
  ]);
  assert.equal(index.size, 1);
  assert.equal(resolveOptionDisplayLabel(index, '9007'), 'Tropical Palm Print');
  assert.deepEqual(applyOptionMapOverrides({ Color: '9007', Size: '5-6Y(110-116)' }, index),
    { Color: 'Tropical Palm Print', Size: '5-6Y(110-116)' });
});

test('applies a color override without reverting the captured source text', () => {
  const result = build(overrides);
  assert.equal(result.payload.colors.colors[0].label, 'Tropical Palm Print');
  assert.equal(result.payload.colors.colors[0].source_label, '9007');
  assert.equal(result.payload.colors.colors[0].image_source_id, '4');
  assert.equal(result.payload.sku_matrix.rows[0].options.Color, 'Tropical Palm Print');
  assert.equal(result.payload.sku_matrix.rows[0].color, 'Tropical Palm Print');
  assert.equal(result.payload.sku_matrix.rows[0].source_options.Color, '9007');
});

test('leaves the payload untouched when no override matches', () => {
  const result = build([]);
  assert.equal(result.payload.colors.colors[0].label, '9007');
  assert.equal(result.payload.colors.colors[0].source_label, undefined);
  assert.equal(result.payload.sku_matrix.rows[0].options.Color, '9007');
  assert.equal(result.payload.sku_matrix.rows[0].color, '9007');
});

test('keeps the override when the translation is regenerated with the same code', () => {
  // This is the re-capture / translation-refresh case: the source SKU text is
  // written back verbatim, and the override must still win.
  const regenerated = {
    ...translation,
    sku_dimensions: [{ name: 'Color', values: ['9007'] }, { name: 'Size', values: ['5-6Y(110-116)'] }],
    sku_rows: [{ skuKey: '5-6Y(110-116)', skuText: '5-6Y(110-116)',
      options: { Size: '5-6Y(110-116)', Color: '9007' } }],
  };
  const result = build(overrides, regenerated);
  assert.equal(result.payload.colors.colors[0].label, 'Tropical Palm Print');
  assert.equal(result.payload.sku_matrix.rows[0].options.Color, 'Tropical Palm Print');
  assert.equal(result.payload.sku_matrix.rows[0].source_options.Color, '9007');
});

test('matches an override regardless of case and spacing in the source text', () => {
  const result = build([{ dimension_name: 'Color', source_text: ' 9007 ', display_label: ' Tropical   Palm Print ' }]);
  assert.equal(result.payload.colors.colors[0].label, 'Tropical Palm Print');
});

test('re-applies overrides to a payload saved before the override existed', () => {
  // The price, style-number, and date repairs replay the saved payload as-is,
  // so a payload captured earlier must be corrected on the way out too.
  const saved = {
    external_id: '1688:597954281596', style_no: 'SKG166',
    colors: { default: 'color-1', colors: [{ label: '9007', value: 'color-1', image_id: 34738 }] },
    sku_matrix: { rows: [{ index: 0, color: '9007',
      options: { Size: '5-6Y(110-116)', Color: '9007' },
      source_options: { Size: '5-6Y(110-116)', Color: '9007' } }] },
  };
  const patched = applyOptionOverridesToPayload(saved, overrides);
  assert.equal(patched.colors.colors[0].label, 'Tropical Palm Print');
  assert.equal(patched.colors.colors[0].image_id, 34738);
  assert.equal(patched.sku_matrix.rows[0].options.Color, 'Tropical Palm Print');
  assert.equal(patched.sku_matrix.rows[0].color, 'Tropical Palm Print');
  assert.equal(patched.sku_matrix.rows[0].source_options.Color, '9007');
  // The caller's payload is never mutated in place.
  assert.equal(saved.colors.colors[0].label, '9007');
  assert.equal(applyOptionOverridesToPayload(saved, []).colors.colors[0].label, '9007');
});
