// 1688 source listing status for captures that no shop scan can see.
//
// Products captured outside a shop scan have no shop_products row, so the daily
// shop reconciliation can never observe whether 1688 still lists them. The
// LinkFox offer gateway returns a `status` for a bare offer id ("published" for
// a live offer, e.g. "member expired" for a removed one), which is enough to
// classify the source state without opening a 1688 page.

/** Statuses that mean the offer is no longer listed on 1688. */
const DELISTED_STATUSES = new Set([
  'member expired',
  'offline',
  'deleted',
  'removed',
  'closed',
  'expired',
  'invalid',
]);

/**
 * Classify a LinkFox product-detail record:
 *   active   -> status "published"
 *   delisted -> a known off-shelf status (e.g. "member expired")
 *   unknown  -> anything else (never triggers an unpublish)
 */
export function classifyLinkFoxListingStatus(raw) {
  const status = String(raw?.status ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const soldOut = String(raw?.soldOut ?? '').trim() || null;
  let state = 'unknown';
  if (status === 'published') state = 'active';
  else if (DELISTED_STATUSES.has(status)) state = 'delisted';
  return { status: status || 'unknown', soldOut, state };
}
