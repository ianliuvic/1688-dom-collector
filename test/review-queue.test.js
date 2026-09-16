import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewItem, buildReviewQueue, buildAuditView, classifyAuditWarnings } from '../src/review-queue.js';

// Shapes below mirror real auditor output pulled from production audits.
const warn = (code, severity, extra = {}) => ({ code, severity, ...extra });

function row(overrides = {}) {
  const base = {
    id: 2400,
    offer_id: '1000000000000',
    item_no: 'YLN-TEST',
    title: '测试商品',
    source_url: 'https://detail.1688.com/offer/1000000000000.html',
    shop_id: 9,
    shop_name: '测试店铺',
    source_category: '比基尼、分体泳衣',
    listing_time: null,
    first_seen_at: '2026-09-15T00:00:00.000Z',
    last_crawled_at: '2026-09-15T00:00:00.000Z',
    currency: 'CNY',
    price_min: 18,
    price_max: 18,
    gallery_verified_complete: true,
    gallery_image_count: 5,
    duplicate_status: 'not_checked',
    duplicate_analysis: {},
    wp_status: null,
    wp_url: null,
    style_no: null,
    publication_error: null,
    rag_active: false,
    rag_status: null,
    image_audit_status: 'clear',
    image_audit_run_status: 'completed',
    image_audit_error: null,
    image_audit_summary: {},
    image_audit_result: { warnings: [] },
    image_audit_completed_at: null,
    sku_audit_status: 'clear',
    sku_audit_run_status: 'completed',
    sku_audit_error: null,
    sku_audit_summary: {},
    sku_audit_result: { warnings: [] },
    sku_audit_completed_at: null,
    images: [{ type: 'main', sortOrder: 0, sourceUrl: 'https://example.test/main.jpg' }],
  };
  return { ...base, ...overrides };
}

test('a review-level warning blocks publication', () => {
  const item = buildReviewItem(row({
    sku_audit_result: { warnings: [warn('sku_row_dimension_mismatch', 'review')] },
  }));
  assert.equal(item.bucket, 'needs_review');
  assert.deepEqual(item.blockingWarnings.map((w) => w.code), ['sku_row_dimension_mismatch']);
});

test('info and warning level entries never block on their own', () => {
  const item = buildReviewItem(row({
    sku_audit_result: {
      warnings: [
        warn('single_value_color_dimension', 'info'),
        warn('nonstandard_variant_naming', 'warning'),
        warn('mixed_color_pattern_name', 'info'),
      ],
    },
  }));
  assert.equal(item.bucket, 'ready_to_publish');
  assert.equal(item.blockingWarnings.length, 0);
  assert.equal(item.skuAudit.passThrough.length, 3);
});

test('a missing size chart passes through even at review level', () => {
  // This is the exact shape of a product the production run published.
  const item = buildReviewItem(row({
    image_audit_summary: { firstImageIssues: ['first_image_not_front'] },
    sku_audit_result: {
      warnings: [
        warn('missing_size_chart', 'review', { confidence: 0.8 }),
        warn('single_value_color_dimension', 'info'),
        warn('duplicate_gallery_image', 'info'),
      ],
    },
  }));
  assert.equal(item.bucket, 'ready_to_publish');
  assert.equal(item.blockingWarnings.length, 0);
  assert.equal(item.skuAudit.passThrough.length, 3);
  // A non-front first image is a notice, never a blocker.
  assert.equal(item.notices[0].code, 'first_image_not_front');
});

test('the same cause spelling differently is still one cause', () => {
  // Observed in production across model versions and between runs: V4.1-Flash
  // mixes snake_case with ALL_CAPS_UNDERSCORE for identical meanings.
  for (const code of ['missing_size_chart', 'MISSING_SIZE_CHART', 'SIZE_CHART_MISSING',
    'size_chart_absent', 'SizeChartAbsent']) {
    const { blocking, passThrough } = classifyAuditWarnings({ warnings: [warn(code, 'review')] });
    assert.equal(blocking.length, 0, code);
    assert.equal(passThrough.length, 1, code);
  }
});

test('an unusable audit response is detected whatever the spelling', () => {
  for (const code of ['model_response_not_json', 'MODEL_RESPONSE_NOT_JSON',
    'modelResponseInvalid', 'invalid_json_response']) {
    const { unusable } = classifyAuditWarnings({ warnings: [warn(code, 'review')] });
    assert.equal(unusable.length, 1, code);
  }
});

test('a real blocker stays a blocker under any spelling', () => {
  const { blocking } = classifyAuditWarnings({
    warnings: [warn('COLOR_TEXT_IMAGE_INCONSISTENT', 'review')],
  });
  assert.equal(blocking.length, 1);
});

test('a merely similar code is not over-allowed', () => {
  const { blocking } = classifyAuditWarnings({ warnings: [warn('size_chart_not_standard', 'review')] });
  assert.equal(blocking.length, 1);
});

test('an unusable auditor response needs a re-run instead of a human decision', () => {
  const item = buildReviewItem(row({
    sku_audit_result: { warnings: [warn('model_response_not_json', 'review', { confidence: 1 })] },
  }));
  assert.equal(item.bucket, 'needs_audit_rerun');
  assert.equal(item.skuAudit.usable, false);
});

test('a product without audits needs a re-run', () => {
  const item = buildReviewItem(row({
    image_audit_run_status: null,
    image_audit_status: null,
    sku_audit_run_status: null,
    sku_audit_status: null,
  }));
  assert.equal(item.bucket, 'needs_audit_rerun');
});

test('a failed audit run needs a re-run even when warnings look clean', () => {
  const item = buildReviewItem(row({
    image_audit_run_status: 'failed',
    image_audit_error: 'vision model timeout',
  }));
  assert.equal(item.bucket, 'needs_audit_rerun');
  assert.equal(item.imageAudit.usable, false);
});

test('published products land in their own bucket even with old warnings', () => {
  const item = buildReviewItem(row({
    wp_status: 'publish',
    wp_url: 'https://wearhongxiu.com/product/example/',
    style_no: 'WHX-0001',
    sku_audit_result: { warnings: [warn('sku_rows_missing_dimension', 'review')] },
  }));
  assert.equal(item.bucket, 'published');
  assert.equal(item.blockingWarnings.length, 1);
});

test('duplicate candidates are a notice while an incomplete gallery blocks', () => {
  const item = buildReviewItem(row({
    gallery_verified_complete: false,
    duplicate_status: 'similar_candidates',
    duplicate_analysis: { decision: 'manual_review', reason: '类似候选需人工参考' },
  }));
  assert.equal(item.bucket, 'needs_review');
  assert.deepEqual(item.blockingWarnings.map((w) => w.code), ['gallery_incomplete']);
  assert.ok(item.notices.map((n) => n.code).includes('similar_candidates'));
});

test('a complete gallery adds no policy blocker', () => {
  const item = buildReviewItem(row({ gallery_verified_complete: true }));
  assert.equal(item.bucket, 'ready_to_publish');
  assert.equal(item.blockingWarnings.length, 0);
});

test('duplicate audit warnings are reported once', () => {
  const { blocking } = classifyAuditWarnings({
    warnings: [
      warn('color_name_image_mismatch', 'review'),
      warn('color_name_image_mismatch', 'review'),
    ],
  });
  assert.equal(blocking.length, 1);
});

test('an audit view without a result object is still safe', () => {
  const view = buildAuditView({ runStatus: 'completed', result: null });
  assert.deepEqual(view.blocking, []);
  assert.equal(view.usable, true);
});

test('images expose the id and locality the page needs to stay same-origin', () => {
  const item = buildReviewItem(row({
    images: [
      { id: 91, type: 'main', sortOrder: 0, sourceUrl: 'https://cdn.test/a.webp', local: true },
      { id: null, type: 'gallery', sortOrder: 1, sourceUrl: 'https://cdn.test/b.webp', local: false },
      { id: 93, type: 'gallery', sortOrder: 2, sourceUrl: null, local: true },
    ],
  }));
  assert.deepEqual(item.images, [
    { id: 91, type: 'main', sortOrder: 0, sourceUrl: 'https://cdn.test/a.webp', local: true },
    { id: null, type: 'gallery', sortOrder: 1, sourceUrl: 'https://cdn.test/b.webp', local: false },
  ]);
});

// Regression: the page rendered its counters but no products because the API
// response carried the summary without the items themselves.
test('buildReviewQueue returns items next to the counters', () => {
  const queue = buildReviewQueue([
    row({ id: 1 }),
    row({ id: 2, sku_audit_result: { warnings: [warn('sku_row_dimension_mismatch', 'review')] } }),
    row({ id: 3, sku_audit_run_status: null, sku_audit_status: null }),
  ]);
  assert.equal(queue.items.length, 3);
  assert.deepEqual(queue.items.map((i) => i.id), [1, 2, 3]);
  assert.deepEqual(queue.counts, {
    total: 3, needs_review: 1, needs_audit_rerun: 1, ready_to_publish: 1,
    source_policy_skipped: 0, published: 0,
  });
});

test('legacy captures outside the source policy are not human work', () => {
  const queue = buildReviewQueue([
    row({
      id: 1,
      ingestion_eligible: false,
      ingestion_reason: 'source_category_is_not_swim_coverup',
      sku_audit_result: { warnings: [warn('sku_matrix_missing_color_dimension', 'review')] },
    }),
    row({ id: 2, sku_audit_result: { warnings: [warn('sku_row_dimension_mismatch', 'review')] } }),
  ]);
  assert.equal(queue.items[0].bucket, 'source_policy_skipped');
  assert.equal(queue.counts.source_policy_skipped, 1);
  // The skipped shop must not appear as pending work nor inflate the causes.
  assert.deepEqual(queue.topBlockingCodes, [{ label: 'sku_row_dimension_mismatch', products: 1 }]);
  assert.deepEqual(queue.pendingByShop, [{ label: '测试店铺', products: 1 }]);
});

test('the cause distribution merges auditor code casing variants', () => {
  const queue = buildReviewQueue([
    row({ id: 1, sku_audit_result: { warnings: [warn('nonstandard_variant_name', 'review')] } }),
    row({ id: 2, sku_audit_result: { warnings: [warn('NON_STANDARD_VARIANT_NAME', 'review')] } }),
  ]);
  assert.deepEqual(queue.topBlockingCodes, [{ label: 'nonstandard_variant_name', products: 2 }]);
  assert.equal(queue.counts.needs_review, 2);
});

test('the blocking-code distribution ignores published history', () => {
  const queue = buildReviewQueue([
    row({
      id: 1,
      wp_status: 'publish',
      sku_audit_result: { warnings: [warn('nonstandard_size_names', 'review')] },
    }),
    row({ id: 2, sku_audit_result: { warnings: [warn('sku_row_dimension_mismatch', 'review')] } }),
  ]);
  assert.deepEqual(queue.topBlockingCodes, [{ label: 'sku_row_dimension_mismatch', products: 1 }]);
  assert.deepEqual(queue.pendingByShop, [{ label: '测试店铺', products: 1 }]);
});
