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

export function selectBestSellers(candidates, target = 48, { random = Math.random, girlsSwimMax = 5 } = {}) {
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
  const bySales = (left, right) => numeric(right.sale_quantity, -1) - numeric(left.sale_quantity, -1)
    || timestamp(right.listing_time) - timestamp(left.listing_time)
    || numeric(left.wp_post_id) - numeric(right.wp_post_id);
  const isGirlsSwim = (item) => /^SKG/i.test(String(item?.style_no ?? '').trim());

  // Girl's Swim (SKG styles) never occupy more than five slots overall.
  let girlsUsed = 0;
  const admits = (item) => {
    if (!isGirlsSwim(item)) return true;
    if (girlsUsed >= Math.max(0, Math.floor(numeric(girlsSwimMax)))) return false;
    girlsUsed += 1;
    return true;
  };

  // 1) Global merit ranking by 1688 sales (from the official plugin shop scans).
  const ranking = [...unique.values()].sort(bySales);
  const topCount = safeTarget > 32 ? 32 : safeTarget;
  const tailCount = safeTarget - topCount;
  const keptTop = [];
  for (const item of ranking) {
    if (keptTop.length >= topCount) break;
    if (admits(item)) keptTop.push(item);
  }
  const keptIds = new Set(keptTop.map((item) => item.wp_post_id));

  // 2) Shop-proportional selection (every shop with published products gets a
  //    fair share), then randomly draw the tail slots from it.
  const allocations = allocateBestSellerSlots([...shops.values()], safeTarget);
  const proportional = [];
  for (const group of allocations) {
    group.candidates.sort(bySales);
    proportional.push(...group.candidates.slice(0, group.allocation));
  }
  const pool = proportional.filter((item) => !keptIds.has(item.wp_post_id));
  const shuffled = [...pool];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  const randomTail = [];
  for (const item of shuffled) {
    if (randomTail.length >= tailCount) break;
    if (admits(item)) randomTail.push(item);
  }

  // 3) Any tail slots the random draw could not fill fall back to the global
  //    ranking order (still respecting the Girl's Swim cap).
  const chosenIds = new Set(randomTail.map((item) => item.wp_post_id));
  const fallbackTail = [];
  for (const item of ranking.slice(topCount)) {
    if (keptTop.length + randomTail.length + fallbackTail.length >= safeTarget) break;
    if (chosenIds.has(item.wp_post_id) || keptIds.has(item.wp_post_id)) continue;
    if (admits(item)) fallbackTail.push(item);
  }
  const selected = [...keptTop, ...randomTail, ...fallbackTail].slice(0, safeTarget);

  return {
    target: safeTarget,
    eligiblePublished: unique.size,
    allocations: allocations.map(({ candidates: ignored, remainder: ignoredRemainder, ...row }) => row),
    keptTop: keptTop.length,
    randomTail: randomTail.length,
    girlsSwim: selected.filter(isGirlsSwim).length,
    selected,
  };
}
