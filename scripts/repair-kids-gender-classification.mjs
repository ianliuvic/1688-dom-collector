import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
const collectorBaseUrl = (process.env.COLLECTOR_BASE_URL || 'https://collector.yiswim.cloud').replace(/\/$/, '');
const apiKey = process.env.ADMIN_API_KEY || process.env.COLLECTOR_API_KEY;

if (!databaseUrl) throw new Error('DATABASE_URL is required.');

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const BOY_PATTERN = /\b(?:boys?|boy's|swim trunks?|swim shorts?|boxer|boardshorts?|jammers?)\b/i;
const GIRL_PATTERN = /\b(?:girls?|girl's|bikini|ruffles?|ruffled|skirts?|skirted|dress|one-shoulder|halter|cross-?back|swimdress)\b/i;

function classify(title) {
  if (BOY_PATTERN.test(title)) {
    return { kind: 'boy', categoryIds: [23, 323], primaryCategoryId: 323, primaryCategory: 'Boys Swim' };
  }
  if (GIRL_PATTERN.test(title)) {
    return { kind: 'girl', categoryIds: [23, 40], primaryCategoryId: 40, primaryCategory: "Girl's Swim" };
  }
  return { kind: 'neutral', categoryIds: [23], primaryCategoryId: 23, primaryCategory: 'kids swimwear' };
}

function updatedPayload(payload, classification) {
  return {
    ...(payload || {}),
    category_ids: classification.categoryIds,
    meta: {
      ...(payload?.meta || {}),
      style: classification.primaryCategory,
      primary_category_id: String(classification.primaryCategoryId),
      primary_category: classification.primaryCategory,
    },
  };
}

async function queueRagSync(productDetailId) {
  if (!apiKey) return false;
  const response = await fetch(`${collectorBaseUrl}/api/product-details/${productDetailId}/rag-sync`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  return response.ok;
}

try {
  const selected = await pool.query(`
    SELECT DISTINCT publications.id, publications.product_detail_id, publications.payload,
      publications.result, details.offer_id
    FROM product_wordpress_publications publications
    JOIN product_details details ON details.id=publications.product_detail_id
    JOIN shop_products products ON products.offer_id=details.offer_id
    WHERE publications.wp_status='publish' AND products.shop_id IN (19,20)
  `);

  const counts = { audited: selected.rowCount, boy: 0, girl: 0, neutral: 0, updated: 0, ragQueued: 0 };
  for (const row of selected.rows) {
    const classification = classify(String(row.payload?.title || ''));
    counts[classification.kind] += 1;
    const payload = updatedPayload(row.payload, classification);
    const result = {
      ...(row.result || {}),
      primary_category_id: classification.primaryCategoryId,
      primary_category: classification.primaryCategory,
      category_ids: classification.categoryIds,
    };
    await pool.query(`
      UPDATE product_wordpress_publications
      SET payload=$2::jsonb, result=$3::jsonb, updated_at=now()
      WHERE id=$1
    `, [row.id, JSON.stringify(payload), JSON.stringify(result)]);
    counts.updated += 1;
    if (await queueRagSync(row.product_detail_id)) counts.ragQueued += 1;
  }
  console.log(JSON.stringify(counts));
} finally {
  await pool.end();
}
