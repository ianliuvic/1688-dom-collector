// Classification logic behind the read-only review page (`/review`).
//
// db.listReviewQueue() supplies the captured product plus its latest image and
// SKU audit rows; this module decides which products a human still has to look
// at. The blocking rule deliberately mirrors what the production publish flow
// already enforces:
//
//   * an auditor warning blocks publication only when the auditor marks it
//     `review`; `info` and `warning` entries are advisory and never block;
//   * a missing size chart is emitted at `review` level but the existing rule
//     already allows it through (fresh data is kept and the standard size chart
//     is used instead), so it is listed in PASS_THROUGH_REVIEW_CODES;
//   * a first image that is not the front view, a single-colour-only dimension
//     or a similar-product candidate are never blocking on their own — they are
//     surfaced as notices.
//
// Auditors mix code casing (`missing_size_chart` vs `SIZE_CHART_MISSING`), so
// codes are compared case-insensitively.

export const PASS_THROUGH_REVIEW_CODES = new Set([
  'missing_size_chart',
]);

// These codes mean the auditor never produced a usable verdict: the audit has to
// be re-run rather than judged by hand.
const UNUSABLE_AUDIT_CODES = new Set([
  'model_response_not_json',
  'model_response_invalid',
  'invalid_json_response',
]);

export const REVIEW_BUCKETS = ['needs_review', 'needs_audit_rerun', 'ready_to_publish', 'source_policy_skipped', 'published'];

export const REVIEW_BUCKET_LABELS = {
  needs_review: '待人工审核',
  needs_audit_rerun: '需重跑审计',
  ready_to_publish: '可放行',
  source_policy_skipped: '来源策略跳过',
  published: '已发布',
};

// Buckets that represent work a human can act on.
const ACTIONABLE_BUCKETS = new Set(['needs_review', 'needs_audit_rerun']);

export function classifyAuditWarnings(result) {
  const raw = result && typeof result === 'object' && Array.isArray(result.warnings) ? result.warnings : [];
  const blocking = [];
  const passThrough = [];
  const unusable = [];
  const seen = new Set();
  for (const warning of raw) {
    const normalized = normalizeWarning(warning);
    if (!normalized) continue;
    const key = `${normalized.codeKey}|${normalized.severity}|${normalized.scope ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (UNUSABLE_AUDIT_CODES.has(normalized.codeKey)) {
      blocking.push(normalized);
      unusable.push(normalized);
      continue;
    }
    if (normalized.severity === 'review' && !PASS_THROUGH_REVIEW_CODES.has(normalized.codeKey)) {
      blocking.push(normalized);
      continue;
    }
    passThrough.push(normalized);
  }
  return { blocking, passThrough, unusable };
}

export function buildAuditView(audit) {
  const source = audit ?? {};
  const warnings = classifyAuditWarnings(source.result);
  const runStatus = source.runStatus ?? null;
  return {
    auditStatus: source.auditStatus ?? null,
    runStatus,
    error: source.error ?? null,
    completedAt: source.completedAt ?? null,
    summary: source.summary && typeof source.summary === 'object' ? source.summary : {},
    blocking: warnings.blocking,
    passThrough: warnings.passThrough,
    unusable: warnings.unusable,
    // An audit row that never finished (or that failed) cannot be reviewed: the
    // product needs another audit run before a human judges anything.
    usable: runStatus === 'completed' && !source.error && warnings.unusable.length === 0,
  };
}

export function buildReviewItem(row) {
  const imageAudit = buildAuditView({
    auditStatus: row.image_audit_status,
    runStatus: row.image_audit_run_status,
    error: row.image_audit_error,
    summary: row.image_audit_summary,
    result: row.image_audit_result,
    completedAt: row.image_audit_completed_at,
  });
  const skuAudit = buildAuditView({
    auditStatus: row.sku_audit_status,
    runStatus: row.sku_audit_run_status,
    error: row.sku_audit_error,
    summary: row.sku_audit_summary,
    result: row.sku_audit_result,
    completedAt: row.sku_audit_completed_at,
  });
  const blockingWarnings = [...imageAudit.blocking, ...skuAudit.blocking, ...buildPolicyBlockers(row)];
  const published = row.wp_status === 'publish';
  const needsRerun = !imageAudit.usable || !skuAudit.usable;
  // Legacy captures from a shop whose source category is not an allowed swim
  // cover-up can never be published, so they must not queue up as human work.
  const sourceSkipped = row.ingestion_eligible === false || Boolean(row.ingestion_reason);

  let bucket = 'ready_to_publish';
  if (published) bucket = 'published';
  else if (sourceSkipped) bucket = 'source_policy_skipped';
  else if (needsRerun) bucket = 'needs_audit_rerun';
  else if (blockingWarnings.length) bucket = 'needs_review';

  return {
    id: Number(row.id),
    offerId: row.offer_id ?? null,
    itemNo: row.item_no ?? null,
    title: row.title ?? null,
    sourceUrl: row.source_url ?? null,
    shopId: row.shop_id == null ? null : Number(row.shop_id),
    shopName: row.shop_name ?? null,
    sourceCategory: row.source_category ?? null,
    listingTime: toIso(row.listing_time),
    firstSeenAt: toIso(row.first_seen_at),
    lastCrawledAt: toIso(row.last_crawled_at),
    currency: row.currency ?? 'CNY',
    priceMin: toNumber(row.price_min),
    priceMax: toNumber(row.price_max),
    galleryVerifiedComplete: row.gallery_verified_complete === true,
    galleryImageCount: Number(row.gallery_image_count ?? 0),
    duplicateStatus: row.duplicate_status ?? null,
    duplicateDecision: row.duplicate_analysis?.decision ?? null,
    duplicateReason: row.duplicate_analysis?.reason ?? null,
    sourceSkipped,
    ingestionReason: row.ingestion_reason ?? null,
    publication: {
      status: row.wp_status ?? null,
      url: row.wp_url ?? null,
      styleNo: row.style_no ?? null,
      error: row.publication_error ?? null,
    },
    rag: { active: row.rag_active === true, status: row.rag_status ?? null },
    imageAudit,
    skuAudit,
    blockingWarnings,
    notices: buildNotices(row, imageAudit),
    images: Array.isArray(row.images) ? row.images.map((image) => ({
      type: image?.type ?? null,
      sortOrder: Number(image?.sortOrder ?? 0),
      sourceUrl: image?.sourceUrl ?? null,
    })).filter((image) => image.sourceUrl) : [],
    bucket,
    bucketLabel: REVIEW_BUCKET_LABELS[bucket],
  };
}

export function buildReviewQueue(rows) {
  const items = (Array.isArray(rows) ? rows : []).map(buildReviewItem);
  return { items, ...summarizeReviewQueue(items) };
}

export function summarizeReviewQueue(items) {
  const counts = { total: items.length };
  for (const bucket of REVIEW_BUCKETS) counts[bucket] = 0;
  // Auditors spell the same cause differently (`nonstandard_variant_name`,
  // `NON_STANDARD_VARIANT_NAME`), which would otherwise split one cause across
  // several rows. Group on a punctuation- and case-insensitive key, then show
  // the most common spelling.
  const codeGroups = new Map();
  const shopCounts = new Map();
  for (const item of items) {
    counts[item.bucket] = (counts[item.bucket] ?? 0) + 1;
    // Published and source-policy-skipped products are not work: the first is
    // history, the second can never be published. Neither may shape the
    // "what is blocking work today" summary.
    if (!ACTIONABLE_BUCKETS.has(item.bucket)) continue;
    for (const warning of item.blockingWarnings) {
      const key = normalizeCodeKey(warning.code);
      const spellings = codeGroups.get(key) ?? new Map();
      spellings.set(warning.code, (spellings.get(warning.code) ?? 0) + 1);
      codeGroups.set(key, spellings);
    }
    const shop = item.shopName ?? '未知店铺';
    shopCounts.set(shop, (shopCounts.get(shop) ?? 0) + 1);
  }
  const rank = (map) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([label, products]) => ({ label, products }));
  const codes = [...codeGroups.entries()].map(([key, spellings]) => {
    const entries = [...spellings.entries()];
    const products = entries.reduce((sum, [, count]) => sum + count, 0);
    const label = entries.sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const aLower = a[0] === a[0].toLowerCase();
      const bLower = b[0] === b[0].toLowerCase();
      if (aLower !== bLower) return aLower ? -1 : 1;
      return a[0].localeCompare(b[0]);
    })[0][0];
    return { key, label, products };
  }).sort((a, b) => b.products - a.products || a.key.localeCompare(b.key))
    .map(({ label, products }) => ({ label, products }));
  return { counts, topBlockingCodes: codes, pendingByShop: rank(shopCounts) };
}

function normalizeCodeKey(code) {
  return String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildNotices(row, imageAudit) {
  const notices = [];
  const firstImageIssues = Array.isArray(imageAudit.summary.firstImageIssues)
    ? imageAudit.summary.firstImageIssues
    : [];
  if (firstImageIssues.length) {
    notices.push({
      code: 'first_image_not_front',
      severity: 'notice',
      evidence: '审计认为首图不是正面视图；按现有规则不影响发布，仅提示。',
    });
  }
  if (row.duplicate_status === 'similar_candidates' || row.duplicate_analysis?.decision === 'manual_review') {
    notices.push({
      code: 'similar_candidates',
      severity: 'notice',
      evidence: row.duplicate_analysis?.reason || '存在相似商品候选，仅供人工参考，不作为完全重复拒绝依据。',
    });
  }
  for (const warning of imageAudit.passThrough) notices.push(warning);
  return notices;
}

// Publish conditions the capture flow enforces outside the audit models. These
// have no warning code of their own, so they are turned into blockers here.
function buildPolicyBlockers(row) {
  const blockers = [];
  if (row.gallery_verified_complete === false) {
    blockers.push({
      code: 'gallery_incomplete',
      codeKey: 'gallery_incomplete',
      severity: 'review',
      scope: 'gallery',
      evidence: '严格 DOM Gallery 完整性未通过：发布条件要求 Gallery 完整，不得猜测或强行发布。',
      confidence: null,
    });
  }
  return blockers;
}

function normalizeWarning(warning) {
  if (!warning || typeof warning !== 'object') return null;
  const code = typeof warning.code === 'string' ? warning.code.trim() : '';
  if (!code) return null;
  return {
    code,
    codeKey: code.toLowerCase(),
    severity: typeof warning.severity === 'string' && warning.severity.trim()
      ? warning.severity.trim().toLowerCase() : 'unknown',
    scope: typeof warning.scope === 'string' && warning.scope.trim() ? warning.scope.trim() : null,
    evidence: typeof warning.evidence === 'string' ? warning.evidence.trim() : '',
    confidence: typeof warning.confidence === 'number' ? warning.confidence : null,
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
