/**
 * Detail (description) image capture for 1688 product pages.
 *
 * The description block renders and lazy-loads its images only after the page
 * has been scrolled, so the capture warms the page up first, then finds the
 * description container (class/id hints first, largest image block as a
 * fallback), then keeps scrolling while the image set grows.
 */

const IMAGE_ATTRIBUTES = ['src', 'data-src', 'data-lazyload-src', 'data-ks-lazyload',
  'data-original', 'data-image', 'data-image-url', 'data-lazy-src'];

const CONTAINER_SELECTORS = [
  '#desc-lazyload-container',
  '.desc-lazyload-container',
  '#J-desc',
  '.od-pc-offer-desc',
  '.detail-desc-decorate-richtext',
  '#description',
  '[class*="detail-desc"]',
  '[class*="offer-desc"]',
  '[class*="desc-content"]',
  '[id*="desc"]',
  '[class*="desc"]',
];

const TAB_LABELS = [/商品详情/, /图文详情/, /产品详情/, /详情/];

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
  if (!(host === 'alicdn.com' || host.endsWith('.alicdn.com'))) return null;
  const path = parsed.pathname.toLowerCase();
  if (!/\.(jpg|jpeg|png|webp|gif)(_\.webp)?$/.test(path)) return null;
  parsed.hash = '';
  return parsed.toString();
}

/** Click a description tab if the description block is collapsed behind one. */
async function openDescriptionTab(page) {
  return page.evaluate((patterns) => {
    const regexes = patterns.map((pattern) => new RegExp(pattern));
    const nodes = Array.from(document.querySelectorAll('a, button, li, div[role="tab"], span'));
    for (const node of nodes) {
      const label = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 12) continue;
      if (!regexes.some((regex) => regex.test(label))) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      try { node.click(); return label; } catch { /* keep looking */ }
    }
    return null;
  }, TAB_LABELS.map((regex) => regex.source)).catch(() => null);
}

/** Locate (and mark) the description container; returns diagnostics as well. */
async function locateDescriptionContainer(page) {
  return page.evaluate((selectors) => {
    const describe = (node) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}`
      + `${typeof node.className === 'string' && node.className ? `.${node.className.split(/\s+/).slice(0, 3).join('.')}` : ''}`;
    const excluded = (node) => Boolean(node.closest('header, footer, nav, [class*="gallery" i], [class*="sku" i], [class*="recommend" i], [class*="header" i], [class*="footer" i], [class*="nav" i]'));

    const diagnostics = [];
    let best = null;
    let bestScore = 0;
    const primary = [];
    for (const selector of selectors) {
      try {
        for (const node of document.querySelectorAll(selector)) primary.push(node);
      } catch { /* invalid selectors are skipped */ }
    }
    for (const node of primary) {
      const images = node.querySelectorAll('img').length;
      if (!images) continue;
      const label = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''}`;
      const score = images * 2 + (/(desc|detail)/i.test(label) ? 4 : 0);
      diagnostics.push({ node: describe(node), images, score, kind: 'hint' });
      if (score > bestScore) { best = node; bestScore = score; }
    }

    if (!best) {
      // Fallback: group large images by a shared section ancestor.
      const groups = new Map();
      for (const image of document.querySelectorAll('img')) {
        if (excluded(image)) continue;
        const width = image.naturalWidth || image.width || 0;
        const height = image.naturalHeight || image.height || 0;
        if (width < 420 || height < 200) continue;
        let node = image.parentElement;
        let key = null;
        for (let depth = 0; node && depth < 6; depth += 1) {
          if (node.querySelectorAll('img').length >= 2) { key = node; }
          node = node.parentElement;
        }
        if (!key) continue;
        const entry = groups.get(key) ?? { node: key, images: 0 };
        entry.images += 1;
        groups.set(key, entry);
      }
      for (const entry of groups.values()) {
        diagnostics.push({ node: describe(entry.node), images: entry.images, score: entry.images, kind: 'fallback' });
        if (entry.images > bestScore) { best = entry.node; bestScore = entry.images; }
      }
    }

    diagnostics.sort((left, right) => right.score - left.score);
    if (!best) return { container: null, diagnostics: diagnostics.slice(0, 8), totalImages: document.querySelectorAll('img').length };
    for (const node of document.querySelectorAll('[data-collector-detail-container]')) {
      node.removeAttribute('data-collector-detail-container');
    }
    best.setAttribute('data-collector-detail-container', '1');
    return {
      container: {
        node: describe(best),
        imageCount: best.querySelectorAll('img').length,
      },
      diagnostics: diagnostics.slice(0, 8),
      totalImages: document.querySelectorAll('img').length,
    };
  }, CONTAINER_SELECTORS).catch(() => ({ container: null, diagnostics: [], totalImages: null }));
}

/**
 * Scroll the page until the description images stop growing, then return the
 * distinct Alibaba CDN image URLs found inside the description container.
 */
export async function extractDetailImageUrls(page, options = {}) {
  const maxRounds = Number(options.maxRounds) || 24;
  const scrollStep = Number(options.scrollStep) || 800;
  const waitMs = Number(options.waitMs) || 900;

  let located = { container: null, diagnostics: [], totalImages: null };
  let tabLabel = null;

  // Warm-up: the description block only renders after some scrolling.
  for (let round = 0; round < 8 && !located.container; round += 1) {
    if (round === 3 && !tabLabel) tabLabel = await openDescriptionTab(page);
    located = await locateDescriptionContainer(page);
    if (located.container) break;
    await page.evaluate((step) => window.scrollBy(0, step), scrollStep).catch(() => {});
    await page.waitForTimeout(waitMs);
  }

  const urls = new Set();
  let stableRounds = 0;
  for (let round = 0; round < maxRounds && stableRounds < 3; round += 1) {
    if (!located.container && round % 3 === 0) located = await locateDescriptionContainer(page);
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

  return {
    container: located.container,
    diagnostics: located.diagnostics,
    totalImages: located.totalImages,
    tabLabel,
    urls: [...urls],
  };
}
