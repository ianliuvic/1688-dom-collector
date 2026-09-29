/**
 * Detail (description) image capture for 1688 product pages.
 *
 * The description block renders and lazy-loads its images only after the page
 * has been scrolled. The capture warms the page up (scroll + tab click + waits),
 * then searches every frame for the description container (class/id hints first,
 * largest large-image block as a fallback) and keeps scrolling while the image
 * set grows.
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
  '[class*="desc" i]',
  '[id*="desc" i]',
];

const TAB_LABELS = ['商品详情', '图文详情', '产品详情', '宝贝详情', '详情'];

/** Runs inside the page: locate (and mark) the description container, with diagnostics. */
function locateScript(selectors) {
  const describe = (node) => node.tagName.toLowerCase()
    + (node.id ? '#' + node.id : '')
    + (typeof node.className === 'string' && node.className ? '.' + node.className.split(/\s+/).slice(0, 3).join('.') : '');
  const excluded = (node) => Boolean(node.closest('header, footer, nav, [class*="gallery" i], [class*="sku" i], [class*="recommend" i], [class*="header" i], [class*="footer" i], [class*="nav" i]'));
  for (const marker of document.querySelectorAll('[data-collector-detail-container]')) marker.removeAttribute('data-collector-detail-container');

  const diagnostics = [];
  let best = null;
  let bestScore = 0;
  for (const selector of selectors) {
    let nodes = [];
    try { nodes = document.querySelectorAll(selector); } catch { continue; }
    for (const node of nodes) {
      const images = node.querySelectorAll('img').length;
      if (!images) continue;
      const label = (node.id || '') + ' ' + (typeof node.className === 'string' ? node.className : '');
      const score = images * 2 + (/(desc|detail)/i.test(label) ? 4 : 0);
      diagnostics.push({ node: describe(node), images, score, kind: 'hint' });
      if (score > bestScore) { best = node; bestScore = score; }
    }
  }
  if (!best) {
    const groups = new Map();
    for (const image of document.querySelectorAll('img')) {
      if (excluded(image)) continue;
      const width = image.naturalWidth || image.width || 0;
      const height = image.naturalHeight || image.height || 0;
      if (width < 380 || height < 160) continue;
      let node = image.parentElement;
      let key = null;
      for (let depth = 0; node && depth < 6; depth += 1) {
        if (node.querySelectorAll('img').length >= 2) key = node;
        node = node.parentElement;
      }
      if (!key) continue;
      const entry = groups.get(key) || { node: key, images: 0 };
      entry.images += 1;
      groups.set(key, entry);
    }
    for (const entry of groups.values()) {
      diagnostics.push({ node: describe(entry.node), images: entry.images, score: entry.images, kind: 'fallback' });
      if (entry.images > bestScore) { best = entry.node; bestScore = entry.images; }
    }
  }
  diagnostics.sort((left, right) => right.score - left.score);
  if (!best) return { container: null, diagnostics: diagnostics.slice(0, 6), totalImages: document.querySelectorAll('img').length };
  best.setAttribute('data-collector-detail-container', '1');
  return {
    container: { node: describe(best), imageCount: best.querySelectorAll('img').length },
    diagnostics: diagnostics.slice(0, 6),
    totalImages: document.querySelectorAll('img').length,
  };
}

/**
 * The description content is usually fetched by the page from a CDN payload
 * (`detailUrl` in the `od_product_description` module state). Reading that
 * payload directly is far more reliable than waiting for the lazy DOM render.
 */
export async function fetchDescriptionPayloadUrls(page, options = {}) {
  const detailUrl = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const matches = [...html.matchAll(/"detailUrl"\s*:\s*"(https?:[^"]*)"/g)]
      .map((match) => match[1].replace(/\\\//g, '/').replace(/\\u002F/gi, '/'));
    const unique = [...new Set(matches)];
    return unique.find((url) => /itemcdn|tmall|\/1688offer\//i.test(url)) ?? unique[0] ?? null;
  }).catch(() => null);
  if (!detailUrl) return { detailUrl: null, urls: [], status: null };

  const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://detail.1688.com/' };
  let text = null;
  let status = null;
  try {
    if (options.requestContext?.request) {
      const response = await options.requestContext.request.get(detailUrl, { headers, timeout: 20000 });
      status = response.status();
      text = response.ok() ? await response.text() : null;
    } else {
      const response = await fetch(detailUrl, { headers, signal: AbortSignal.timeout(20000) });
      status = response.status;
      text = response.ok ? await response.text() : null;
    }
  } catch (error) {
    return { detailUrl, urls: [], status, error: String(error?.message ?? error) };
  }
  if (!text) return { detailUrl, urls: [], status };

  const urls = [];
  for (const raw of text.matchAll(/https?:(?:\\\/|\/)[^"'\s<>\\]*(?:cbu01|img\.alicdn|alicdn)[^"'\s<>\\]*/gi)) {
    const url = normalizeImageUrl(raw[0].replace(/\\\//g, '/').replace(/\\u002F/gi, '/'), detailUrl);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return { detailUrl, urls, status, bytes: text.length };
}

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

async function openDescriptionTab(page) {
  for (const frame of page.frames()) {
    try {
      const label = await frame.evaluate((labels) => {
        const nodes = Array.from(document.querySelectorAll('a, button, li, div[role="tab"], span'));
        for (const node of nodes) {
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 14) continue;
          if (!labels.some((label) => text === label || text.includes(label))) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          try { node.click(); return text; } catch { /* keep looking */ }
        }
        return null;
      }, TAB_LABELS);
      if (label) return label;
    } catch { /* frame not accessible */ }
  }
  return null;
}

async function locateAcrossFrames(page) {
  const summaries = [];
  let chosenFrame = null;
  let chosen = null;
  for (const frame of page.frames()) {
    try {
      const located = await frame.evaluate(locateScript, CONTAINER_SELECTORS);
      summaries.push({ frame: frame.url().slice(0, 120), container: located?.container ?? null,
        totalImages: located?.totalImages ?? null, diagnostics: located?.diagnostics ?? [] });
      const imageCount = located?.container?.imageCount ?? 0;
      if (imageCount && (!chosen || imageCount > (chosen.container?.imageCount ?? 0))) {
        chosenFrame = frame;
        chosen = located;
      }
    } catch (error) {
      summaries.push({ frame: frame.url().slice(0, 120), error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { frame: chosenFrame, located: chosen, summaries };
}

async function collectFromFrame(frame) {
  if (!frame) return [];
  return frame.evaluate((attributes) => {
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
}

/**
 * Warm the page up, find the description container in any frame, then scroll
 * until the image set stops growing.
 */
export async function extractDetailImageUrls(page, options = {}) {
  const maxRounds = Number(options.maxRounds) || 26;
  const scrollStep = Number(options.scrollStep) || 900;
  const waitMs = Number(options.waitMs) || 900;

  let located = { frame: null, located: null, summaries: [] };
  let tabLabel = null;

  // Warm-up: description blocks only render after the page has been scrolled.
  for (let round = 0; round < 14 && !located.frame; round += 1) {
    if (round === 2 || round === 6) {
      const label = await openDescriptionTab(page);
      if (label && !tabLabel) tabLabel = label;
    }
    located = await locateAcrossFrames(page);
    if (located.frame) break;
    await page.evaluate((step) => window.scrollBy(0, step), scrollStep).catch(() => {});
    await page.waitForTimeout(waitMs);
  }

  const urls = new Set();
  let stableRounds = 0;
  for (let round = 0; round < maxRounds && stableRounds < 3; round += 1) {
    if (!located.frame && round % 3 === 0) located = await locateAcrossFrames(page);
    const found = await collectFromFrame(located.frame);
    let added = 0;
    for (const raw of found) {
      const url = normalizeImageUrl(raw, located.frame?.url() ?? page.url());
      if (url && !urls.has(url)) { urls.add(url); added += 1; }
    }
    stableRounds = added ? 0 : stableRounds + 1;
    if (added === 0 && round % 4 === 3 && !located.located) {
      located = await locateAcrossFrames(page);
    }
    await page.evaluate((step) => window.scrollBy(0, step), scrollStep).catch(() => {});
    await page.waitForTimeout(waitMs);
  }

  const payload = await fetchDescriptionPayloadUrls(page, { requestContext: options.requestContext });
  const merged = [...new Set([...(payload.urls ?? []), ...urls])];

  return {
    container: located.located?.container ?? null,
    containerFrame: located.frame ? located.frame.url().slice(0, 160) : null,
    frameSummaries: located.summaries,
    tabLabel,
    urls: [...urls],
    detailUrl: payload.detailUrl ?? null,
    detailUrlStatus: payload.status ?? null,
    payloadUrls: payload.urls ?? [],
    urlsTotal: merged.length,
  };
}
