import test from 'node:test';
import assert from 'node:assert/strict';
import { SIZE_CHART_PRESETS, normalizeSizeChart, renderSizeChartPng } from '../src/size-chart.js';

test('WordPress presets remain available with their source columns', () => {
  assert.equal(SIZE_CHART_PRESETS.length, 2);
  assert.equal(SIZE_CHART_PRESETS[0].name, 'US Regular');
  assert.equal(SIZE_CHART_PRESETS[0].columns[0].unit, 'in');
  assert.equal(SIZE_CHART_PRESETS[1].name, "Girls' Swimwear");
  assert.ok(SIZE_CHART_PRESETS[1].columns.some((column) => column.label === 'Height'));
});

test('size chart normalization keeps keys unique and strips unsafe text', () => {
  const chart = normalizeSizeChart({
    name: '  Test chart  ',
    columns: [
      { key: 'size', label: 'Bust', unit: 'cm' },
      { key: 'size', label: 'Waist', unit: 'cm' },
    ],
    rows: [{ size: ' M ', values: { size: ' 88 ' } }],
  });
  assert.equal(chart.name, 'Test chart');
  assert.deepEqual(chart.columns.map((column) => column.key), ['size', 'size_2']);
  assert.equal(chart.rows[0].values.size, '88');
  assert.equal(chart.rows[0].values.size_2, '');
});

test('size chart renders a white-ground PNG', async () => {
  const result = await renderSizeChartPng(SIZE_CHART_PRESETS[0]);
  assert.equal(result.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(result.png.length > 10_000);
  assert.equal(result.chart.rows.length, 8);
});
