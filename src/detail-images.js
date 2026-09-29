/**
 * Detail (description) image capture for 1688 product pages.
 *
 * The description block loads its images lazily, so the page has to be scrolled
 * slowly while the container is re-read. Only images inside the detected
 * description container are returned; gallery / SKU / recommendation images are
 * never included here.
 */

const IMAGE_ATTRIBUTES = ['src', 'data-src', 'data-lazyload-src', 'data-ks-lazyload',
  'data-original', 'data-image', 'data-image-url', 'data-lazy-src'];

const CONTAINER_SELECTORS = [
  '#desc-lazyload-container',
  '.desc-lazyload-container',
  '#J-desc',
  '.od-pc-offer-desc',
  '#description',
  '.detail-desc-decorate-richtext',
  '[class*="detail-desc"]',
  '[class*="offer-desc"]',
  '[id*="desc"]',
  '[class*="desc"]',
];

function normalizeImageUrl(value, baseUrl) {
  if (!value || typeof value !== 'string') return null;
  let candidate = value.trim();
  if (!candidate || candidate.startsWith('data:') || candidate.startsWith('blob:')) return null;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  let parsed;
  try {
    parsed = new URL(candidate, baseUrl || 'https://detail.1688.com/');
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  const isAlibabaImageHost = host === 'alicdn.com' || host.endsWith('.alicdn.com');
  if (!isAlibabaImageHost) return null;
  const path = parsed.pathname.toLowerCase();
  if (!/\.(jpg|jpeg|png|webp|gif)(_\.webp)?$/.test(path)) return null;
  parsed.hash = '';
  return parsed.toString();
}

/** Locate the description container and mark it for later rounds. */
async function locateDescriptionContainer(page) {
  return page.evaluate((selectors) => {
    const candidates = [];
    for (const selector of selectors) {
      try {
        for (const node of document.querySelectorAll(selector)) candidates.push(node);
      } catch { /* invalid selectors are skipped */ }
    }
    let best = null;
    let bestScore = 0;
    for (const node of candidates) {
      if (!node || typeof node.querySelectorAll !== 'function') continue;
      const images = node.querySelectorAll('img').length;
      if (!images) continue;
      const label = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''}`;
      const score = images + (/(desc|detail)/i.test(label) ? 2 : 0);
      if (score > bestScore) { best = node; bestScore = score; }
    }
    if (!best) return null;
    for (const node of document.querySelectorAll('[data-collector-detail-container]')) {
      node.removeAttribute('data-collector-detail-container');
    }
    best.setAttribute('data-collector-detail-container', '1');
    return {
      tag: best.tagName.toLowerCase(),
      id: best.id || null,
      className: String(best.className || '').slice(0, 120),
      imageCount: best.querySelectorAll('img').length,
    };
  }, CONTAINER_SELECTORS);
}

/**
 * Scroll the page until the description images stop growing, then return the
 * distinct Alibaba CDN image URLs found inside the description container.
 */
export async function extractDetailImageUrls(page, options = {}) {
  const maxRounds = Number(options.maxRounds) || 18;
  const scrollStep = Number(options.scrollStep) || 900;
  const waitMs = Number(options.waitMs) || 900;

  const container = await locateDescriptionContainer(page).catch(() => null);
  const urls = new Set();
  let stableRounds = 0;

  for (let round = 0; round < maxRounds && stableRounds < 3; round += 1) {
    const found = await page.evaluate((attributes) => {
      const node = document.querySelector('[data-collector-detail-container="1"]');
      if (!node) return [];
      const values = [];
      for (const image of node.querySelectorAll('img')) {
        for (const name of attributes) {
          const value = image.getAttribute(name);
          if (value) { values.push(value); break; }
        }
        const srcset = image.getAttribute('srcset');
        if (srcset) values.push(srcset.split(',')[0].trim().split(' ')[0]);
      }
      return values;
    }, IMAGE_ATTRIBUTES).catch(() => []);

    let added = 0;
    for (const raw of found) {
      const url = normalizeImageUrl(raw, page.url());
      if (url && !urls.has(url)) { urls.add(url); added += 1; }
    }
    stableRounds = added ? 0 : stableRounds + 1;

    await page.evaluate((step) => window.scrollBy(0, step), scrollStep).catch(() => {});
    await page.waitForTimeout(waitMs);
  }

  return { container, urls: [...urls] };
}
