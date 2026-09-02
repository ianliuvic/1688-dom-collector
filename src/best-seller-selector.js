function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function timestamp(value) {
  const result = value ? new Date(value).getTime() : 0;
  return Number.isFinite(result) ? result : 0;
}

export function allocateBestSellerSlots(groups, target) {
  const rows = groups.map((group) => ({ ...group, allocation: 0, remainder: 0 }));
  const safeTarget = Math.max(0, Math.floor(numeric(target)));
  const total = rows.reduce((sum, row) => sum + row.publishedCount, 0);
  if (!rows.length || !safeTarget || !total) return rows;

  for (const row of rows) {
    const exact = (safeTarget * row.publishedCount) / total;
    row.allocation = Math.min(row.publishedCount, Math.floor(exact));
    row.remainder = exact - Math.floor(exact);
  }

  let remaining = safeTarget - rows.reduce((sum, row) => sum + row.allocation, 0);
  const byRemainder = [...rows].sort((left, right) => right.remainder - left.remainder
    || right.publishedCount - left.publishedCount || left.domain.localeCompare(right.domain));
  for (const row of byRemainder) {
    if (!remaining) break;
    if (row.allocation < row.publishedCount) {
      row.allocation += 1;
      remaining -= 1;
    }
  }

  if (safeTarget >= rows.length) {
    for (const empty of rows.filter((row) => row.publishedCount > 0 && row.allocation === 0)) {
      const donor = [...rows].filter((row) => row.allocation > 1)
        .sort((left, right) => right.allocation - left.allocation
          || left.remainder - right.remainder || left.domain.localeCompare(right.domain))[0];
      if (!donor) break;
      donor.allocation -= 1;
      empty.allocation = 1;
    }
  }
  return rows;
}

export function selectBestSellers(candidates, target = 36) {
  const unique = new Map();
  for (const candidate of candidates ?? []) {
    const postId = numeric(candidate.wp_post_id);
    if (!postId || unique.has(postId)) continue;
    unique.set(postId, { ...candidate, wp_post_id: postId });
  }

  const shops = new Map();
  for (const candidate of unique.values()) {
    const domain = String(candidate.domain ?? '').trim().toLowerCase();
    if (!domain) continue;
    if (!shops.has(domain)) shops.set(domain, {
      shopId: candidate.shop_id,
      shopName: candidate.shop_name || domain,
      domain,
      publishedCount: 0,
      candidates: [],
    });
    const group = shops.get(domain);
    group.publishedCount += 1;
    group.candidates.push(candidate);
  }

  const safeTarget = Math.min(Math.max(0, Math.floor(numeric(target))), unique.size);
  const allocations = allocateBestSellerSlots([...shops.values()], safeTarget);
  const selected = [];
  for (const group of allocations) {
    group.candidates.sort((left, right) => numeric(right.sale_quantity, -1) - numeric(left.sale_quantity, -1)
      || timestamp(right.listing_time) - timestamp(left.listing_time)
      || numeric(left.wp_post_id) - numeric(right.wp_post_id));
    selected.push(...group.candidates.slice(0, group.allocation));
  }

  return {
    target: safeTarget,
    eligiblePublished: unique.size,
    allocations: allocations.map(({ candidates: ignored, remainder: ignoredRemainder, ...row }) => row),
    selected,
  };
}
