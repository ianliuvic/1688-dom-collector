import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProxyAdapter } from './proxy.js';
import { parse1688Product } from './parsers/1688-product.js';
import { parse1688Shop } from './parsers/1688-shop.js';
import {
  fetchAllShopOffers,
  fetchPluginLogin,
  fetchShopOfferPage,
  refreshPluginHeartbeat,
} from './mtop-shop.js';
import { createPluginCrypto } from './plugin-crypto.js';

const AUTH_MARKERS = [
  'login.1688.com',
  'passport.1688.com',
  'member.1688.com/member/signin',
];

const CHALLENGE_TEXT = [
  '请登录',
  '登录后继续',
  '安全验证',
  '验证码',
  '滑动验证',
  '异常访问',
];

const WEB_IM_URL_PATTERN = '**/app/ocms-fusion-components-1688/def_cbu_web_im/**';

async function captureShopContactUrl(page, context) {
  const customerService = page.getByText('客服', { exact: true }).first();
  if (!await customerService.isVisible().catch(() => false)) {
    return { url: null, source: null, error: 'Customer service button was not found.' };
  }

  const directUrl = await customerService.evaluate((element) => {
    const anchor = element.closest('a');
    return anchor?.href || element.getAttribute('href') || element.dataset?.href || null;
  }).catch(() => null);
  if (directUrl?.includes('/def_cbu_web_im/')) {
    return { url: directUrl, source: 'dom', error: null };
  }

  await context.route(WEB_IM_URL_PATTERN, (route) => route.abort('blockedbyclient'));
  await page.evaluate(() => {
    window.__collectorPopupCapture = { urls: [], originalOpen: window.open };
    const record = (value) => {
      if (value == null) return;
      window.__collectorPopupCapture.urls.push(String(value));
    };
    window.open = (url) => {
      record(url);
      return new Proxy({ closed: false, focus() {}, close() {}, postMessage() {} }, {
        set(target, property, value) {
          if (property === 'location' || property === 'href') record(value);
          target[property] = value;
          return true;
        },
      });
    };
  });

  let capturedUrl = null;
  try {
    await customerService.click({ noWaitAfter: true, timeout: 5000 });
    await page.waitForTimeout(750);
    capturedUrl = await page.evaluate(() => window.__collectorPopupCapture?.urls
      ?.find((url) => url.includes('/def_cbu_web_im/')) ?? null);
  } finally {
    await page.evaluate(() => {
      if (window.__collectorPopupCapture?.originalOpen) {
        window.open = window.__collectorPopupCapture.originalOpen;
      }
      delete window.__collectorPopupCapture;
    }).catch(() => {});
    await context.unroute(WEB_IM_URL_PATTERN).catch(() => {});
  }

  return {
    url: capturedUrl,
    source: capturedUrl ? 'window_open_intercept' : null,
    error: capturedUrl ? null : 'The button did not expose a web IM URL.',
  };
}

async function downloadProductImages(data, storagePath, jobId, requestContext = null) {
  const downloadDeadlineAt = Date.now() + 6 * 60 * 1000;
  const sources = [];
  if (data.mainImage) sources.push({ url: data.mainImage, type: 'main' });
  for (const [index, url] of (data.images ?? []).entries()) sources.push({ url, type: 'gallery', sortOrder: index });
  for (const [index, item] of (data.skuOptions ?? []).entries()) {
    if (item.image) sources.push({ url: item.image, type: 'sku', sortOrder: index });
  }
  const seen = new Set();
  const imageDir = path.join(storagePath, 'product-images', String(data.offerId || jobId));
  await fs.mkdir(imageDir, { recursive: true });
  const files = [];
  for (const source of sources) {
    if (Date.now() >= downloadDeadlineAt) break;
    if (!source.url || seen.has(source.url)) continue;
    seen.add(source.url);
    const headers = { 'user-agent': 'Mozilla/5.0', referer: 'https://detail.1688.com/' };
    let downloaded = null;
    for (let attempt = 1; attempt <= 2 && !downloaded
      && Date.now() < downloadDeadlineAt; attempt += 1) {
      try {
        const response = requestContext?.request
          ? await requestContext.request.get(source.url, { headers, timeout: 20000 })
          : await fetch(source.url, { headers, signal: AbortSignal.timeout(20000) });
        const ok = requestContext?.request ? response.ok() : response.ok;
        const responseStatus = requestContext?.request ? response.status() : response.status;
        if (!ok) throw new Error(`Image request failed with HTTP ${responseStatus}.`);
        const contentType = (requestContext?.request
          ? response.headers()['content-type']
          : response.headers.get('content-type'))?.split(';')[0] || 'image/jpeg';
        if (!contentType.startsWith('image/')) throw new Error('Image request returned a non-image response.');
        const bytes = requestContext?.request
          ? await response.body()
          : Buffer.from(await response.arrayBuffer());
        if (!bytes.length) throw new Error('Image request returned an empty body.');
        downloaded = { contentType, bytes };
      } catch {
        if (attempt < 2 && Date.now() < downloadDeadlineAt) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 350));
        }
      }
    }
    // Product media on the Alibaba CDN is public and does not require the
    // logged-in browser session.  A flaky SOCKS/browser request context can
    // therefore fall back to a direct server request, but only for an URL
    // already verified by the exact product Gallery/SKU parser above.
    let directFallbackAllowed = false;
    try {
      const imageHost = new URL(source.url).hostname.toLowerCase();
      directFallbackAllowed = imageHost === 'alicdn.com' || imageHost.endsWith('.alicdn.com')
        || imageHost === '1688.com' || imageHost.endsWith('.1688.com');
    } catch { /* malformed source URLs are never fetched directly */ }
    if (!downloaded && requestContext?.request && directFallbackAllowed
      && Date.now() < downloadDeadlineAt) {
      for (let attempt = 1; attempt <= 1 && !downloaded
        && Date.now() < downloadDeadlineAt; attempt += 1) {
        try {
          const response = await fetch(source.url, {
            headers,
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw new Error(`Image fallback failed with HTTP ${response.status}.`);
          const contentType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
          if (!contentType.startsWith('image/')) {
            throw new Error('Image fallback returned a non-image response.');
          }
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.length) throw new Error('Image fallback returned an empty body.');
          downloaded = { contentType, bytes };
        } catch { /* completeness validation below rejects any missing source image */ }
      }
    }
    if (!downloaded) continue;
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
      'image/gif': 'gif' })[downloaded.contentType] || 'bin';
    const hash = crypto.createHash('sha1').update(source.url).digest('hex').slice(0, 12);
    const filePath = path.join(imageDir,
      `${source.type}-${String(source.sortOrder ?? files.length).padStart(4, '0')}-${hash}.${extension}`);
    await fs.writeFile(filePath, downloaded.bytes);
    files.push({ type: source.type, sortOrder: source.sortOrder ?? files.length, sourceUrl: source.url,
      storagePath: filePath, mimeType: downloaded.contentType,
      contentSha256: crypto.createHash('sha256').update(downloaded.bytes).digest('hex'),
      byteSize: downloaded.bytes.length });
  }
  return files;
}

export function isAllowed1688Url(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === '1688.com' || url.hostname.endsWith('.1688.com'));
  } catch {
    return false;
  }
}

export function is1688ShopUrl(value) {
  try {
    const url = new URL(value);
    const reservedNonShopHosts = ['detail.', 'air.', 'login.', 'passport.', 'member.', 'h5api.'];
    return url.hostname.endsWith('.1688.com')
      && !reservedNonShopHosts.some((prefix) => url.hostname.startsWith(prefix));
  } catch {
    return false;
  }
}

export function createCollector({
  storagePath,
  navigationTimeoutMs,
  proxyServer,
  proxyUsername,
  proxyPassword,
  browserHeadless,
  screenshotMode = 'errors',
  clearStaleBrowserLocks = false,
}) {
  const profilePath = path.join(storagePath, 'browser-profile');
  const capturesPath = path.join(storagePath, 'captures');
  let context;
  let page;
  let proxyAdapter;
  let lifecycleState = 'stopped';
  let activeOperations = 0;
  let idleWaiters = [];
  let sessionState = 'unknown';
  let lastCheckedAt = null;
  const pluginCrypto = createPluginCrypto({ storagePath, refreshToken: refreshPluginHeartbeat });

  async function start() {
    if (lifecycleState === 'running') return;
    if (lifecycleState !== 'stopped') throw new Error(`Collector cannot start while state is ${lifecycleState}.`);
    lifecycleState = 'starting';
    await fs.mkdir(profilePath, { recursive: true });
    await fs.mkdir(capturesPath, { recursive: true });
    if (clearStaleBrowserLocks) {
      await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((name) =>
        fs.rm(path.join(profilePath, name), { force: true, recursive: true })));
    }

    try {
      proxyAdapter = await startProxyAdapter(proxyServer, proxyUsername, proxyPassword);
      context = await chromium.launchPersistentContext(profilePath, {
        headless: browserHeadless,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        viewport: { width: 1440, height: 1000 },
        args: ['--disable-dev-shm-usage', '--password-store=basic'],
        ...(proxyAdapter ? { proxy: proxyAdapter.playwrightProxy } : {}),
      });

      const storageStatePath = path.join(storagePath, 'storage-state.json');
      try {
        const storageState = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
        if (Array.isArray(storageState.cookies) && storageState.cookies.length > 0) {
          await context.addCookies(storageState.cookies);
        }
        if (Array.isArray(storageState.origins) && storageState.origins.length > 0) {
          await context.addInitScript(({ origins }) => {
            const origin = origins.find((item) => item.origin === window.location.origin);
            if (!origin) return;
            for (const item of origin.localStorage ?? []) {
              window.localStorage.setItem(item.name, item.value);
            }
          }, { origins: storageState.origins });
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      page = context.pages()[0] ?? await context.newPage();
      page.setDefaultNavigationTimeout(navigationTimeoutMs);
      lifecycleState = 'running';
    } catch (error) {
      await proxyAdapter?.close().catch(() => {});
      proxyAdapter = null;
      context = null;
      page = null;
      lifecycleState = 'stopped';
      throw error;
    }
  }

  async function stop() {
    if (lifecycleState === 'stopped') return;
    lifecycleState = 'stopping';
    if (activeOperations > 0) {
      await new Promise((resolve) => idleWaiters.push(resolve));
    }
    await context?.storageState({ path: path.join(storagePath, 'storage-state.json') }).catch(() => {});
    await context?.close().catch(() => {});
    await proxyAdapter?.close().catch(() => {});
    context = null;
    page = null;
    proxyAdapter = null;
    lifecycleState = 'stopped';
  }

  async function withOperation(operation) {
    if (lifecycleState !== 'running') throw new Error('Collector browser is not running.');
    activeOperations += 1;
    try {
      return await operation();
    } finally {
      activeOperations -= 1;
      if (activeOperations === 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  function classifySession(finalUrl, bodyText) {
    const lowerUrl = finalUrl.toLowerCase();
    if (AUTH_MARKERS.some((marker) => lowerUrl.includes(marker))) return 'requires_auth';
    if (CHALLENGE_TEXT.some((marker) => bodyText.includes(marker))) return 'requires_auth';
    return 'active';
  }

  async function capture(job) {
    const jobPath = path.join(capturesPath, job.id);
    await fs.mkdir(jobPath, { recursive: true });
    const domPath = path.join(jobPath, 'page.html');
    const screenshotPath = path.join(jobPath, 'page.png');

    if (job.options?.mode === 'product_detail') {
      const detailPage = await context.newPage();
      detailPage.setDefaultNavigationTimeout(navigationTimeoutMs);
      try {
        await detailPage.goto(job.url, { waitUntil: 'domcontentloaded' });
        await detailPage.waitForTimeout(5000);
        const finalUrl = detailPage.url();
        const title = await detailPage.title();
        const bodyText = await detailPage.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        const detailSessionState = classifySession(finalUrl, bodyText);
        sessionState = detailSessionState;
        lastCheckedAt = new Date().toISOString();
        await fs.writeFile(domPath, await detailPage.content(), 'utf8');
        if (detailSessionState === 'requires_auth') {
          return { status: 'requires_auth', title, finalUrl, domPath, screenshotPath: null,
            extractedData: null, error: 'Login or human verification is required.' };
        }
        const extractedData = await parse1688Product(detailPage);
        extractedData.localImages = await downloadProductImages(extractedData, storagePath, job.id, context);
        await fs.writeFile(path.join(jobPath, 'product.json'), JSON.stringify(extractedData, null, 2), 'utf8');
        return { status: 'completed', title, finalUrl, domPath, screenshotPath: null,
          extractedData, error: null };
      } finally {
        await detailPage.close().catch(() => {});
      }
    }

    if (job.options?.mode === 'shop_contact') {
      await page.goto(job.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8000);
      const title = await page.title();
      const finalUrl = page.url();
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      sessionState = classifySession(finalUrl, bodyText);
      lastCheckedAt = new Date().toISOString();
      await fs.writeFile(domPath, await page.content(), 'utf8');
      if (sessionState === 'requires_auth') {
        return {
          status: 'requires_auth', title, finalUrl, domPath, screenshotPath: null,
          extractedData: null, error: 'Login or human verification is required.',
        };
      }
      const contact = await captureShopContactUrl(page, context);
      return {
        status: contact.url ? 'completed' : 'failed', title, finalUrl, domPath,
        screenshotPath: null, extractedData: { contact }, error: contact.error,
      };
    }

    if (job.options?.mode === 'plugin_login') {
      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1500);
        const { payload, result } = await fetchPluginLogin({ context, page });
        const title = await page.title();
        const finalUrl = page.url();
        sessionState = result.isLogin ? 'active' : 'requires_auth';
        lastCheckedAt = new Date().toISOString();
        await fs.writeFile(domPath, await page.content(), 'utf8');
        await fs.writeFile(path.join(jobPath, 'mtop-response.json'), JSON.stringify(payload), 'utf8');
        await fs.writeFile(path.join(jobPath, 'product.json'), JSON.stringify(result, null, 2), 'utf8');
        let savedScreenshotPath = null;
        if (screenshotMode === 'always'
            || (screenshotMode === 'errors' && sessionState !== 'active')) {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          savedScreenshotPath = screenshotPath;
        }
        return {
          status: result.isLogin ? 'completed' : 'requires_auth',
          title, finalUrl, domPath, screenshotPath: savedScreenshotPath,
          extractedData: result,
          error: result.isLogin ? null : 'The 1688 plugin session is not logged in.',
        };
      } catch (error) {
        let savedScreenshotPath = null;
        if (screenshotMode !== 'never') {
          try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            savedScreenshotPath = screenshotPath;
          } catch { /* preserve the original plugin-session error */ }
        }
        error.captureArtifacts = { screenshotPath: savedScreenshotPath };
        throw error;
      }
    }

    if (job.options?.mode === 'shop_mtop') {
      try {
        await page.goto(job.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        const finalUrl = page.url();
        const title = await page.title();
        const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        const shopData = await parse1688Shop(page).catch(() => null);
        const memberId = job.options.memberId || shopData?.company?.memberId;
        sessionState = classifySession(finalUrl, bodyText);
        lastCheckedAt = new Date().toISOString();
        await fs.writeFile(domPath, await page.content(), 'utf8');
        if (sessionState === 'requires_auth') {
          const savedScreenshotPath = screenshotMode === 'never' ? null : screenshotPath;
          if (savedScreenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
          return {
            status: 'requires_auth', title, finalUrl, domPath,
            screenshotPath: savedScreenshotPath, extractedData: null,
            error: 'Login or human verification is required.',
          };
        }

        await page.goto('https://air.1688.com/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);
        const pluginLogin = await fetchPluginLogin({ context, page });
        if (!pluginLogin.result.isLogin) {
          sessionState = 'requires_auth';
          lastCheckedAt = new Date().toISOString();
          return {
            status: 'requires_auth', title, finalUrl, domPath,
            screenshotPath: null, extractedData: pluginLogin.result,
            error: 'The 1688 plugin session is not logged in.',
          };
        }

        if (!memberId) {
          throw new Error('Could not determine the shop memberId from the supplied page.');
        }
        const scan = job.options.allPages
          ? fetchAllShopOffers
          : fetchShopOfferPage;
        const { payload, result } = await scan({
          context, page, pluginCrypto, memberId,
          pageNum: job.options.pageNum,
          pageSize: job.options.pageSize,
          sortType: job.options.sortType,
          ...(job.options.allPages ? { maxPages: job.options.maxPages } : {}),
        });
        result.shop = shopData;
        result.pluginSession = {
          isLogin: true,
          loginId: pluginLogin.result.loginId,
          userId: pluginLogin.result.userId,
        };
        await fs.writeFile(path.join(jobPath, 'mtop-response.json'), JSON.stringify(payload), 'utf8');
        await fs.writeFile(path.join(jobPath, 'product.json'), JSON.stringify(result, null, 2), 'utf8');
        return {
          status: 'completed', title, finalUrl, domPath, screenshotPath: null,
          extractedData: result, error: null,
        };
      } catch (error) {
        let savedScreenshotPath = null;
        if (screenshotMode !== 'never') {
          try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            savedScreenshotPath = screenshotPath;
          } catch { /* preserve the original batch error */ }
        }
        error.captureArtifacts = { screenshotPath: savedScreenshotPath };
        throw error;
      }
    }

    const networkResponses = [];
    const pendingResponses = new Set();
    const responseHandler = (response) => {
      const url = response.url();
      const api = url.match(/mtop\.(?:alibaba\.alisite\.cbu\.server\.moduleasyncservice|1688\.shop\.data\.get)/i)?.[0];
      if (!api || networkResponses.length >= 20) return;
      const pending = response.text().then((body) => {
        if (body.length <= 5 * 1024 * 1024) networkResponses.push({ api: api.toLowerCase(), body });
      }).catch(() => {}).finally(() => pendingResponses.delete(pending));
      pendingResponses.add(pending);
    };
    page.on('response', responseHandler);
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded' });
      const currentUrl = new URL(page.url());
      const isShopPage = is1688ShopUrl(currentUrl.href);
      await page.waitForTimeout(isShopPage ? 8000 : 3000);
      if (job.options?.paginate === true
          && isShopPage && currentUrl.pathname.includes('offerlist')) {
        const paginationText = await page.locator('body').innerText().catch(() => '');
        const totalPages = Math.min(Number(paginationText.match(/\b\d+\/(\d+)\s*到/)?.[1] ?? 1), 20);
        for (let currentPage = 1; currentPage < totalPages; currentPage += 1) {
          const nextButton = page.getByRole('button', { name: /下一页/ }).first();
          if (!await nextButton.isVisible().catch(() => false)) break;
          await nextButton.click();
          await page.waitForTimeout(2500);
        }
      }
      await Promise.allSettled([...pendingResponses]);

      const finalUrl = page.url();
      const title = await page.title();
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      sessionState = classifySession(finalUrl, bodyText);
      lastCheckedAt = new Date().toISOString();
      const status = sessionState === 'requires_auth' ? 'requires_auth' : 'completed';

      await fs.writeFile(domPath, await page.content(), 'utf8');
      const extractedData = status === 'completed'
        ? (isShopPage ? await parse1688Shop(page, networkResponses) : await parse1688Product(page))
        : null;
      if (extractedData?.pageType === 'shop') {
        const contact = await captureShopContactUrl(page, context).catch(() => ({ url: null }));
        extractedData.wangwangUrl = contact.url;
      }
      let savedScreenshotPath = null;
      if (screenshotMode === 'always' || (screenshotMode === 'errors' && status !== 'completed')) {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        savedScreenshotPath = screenshotPath;
      }
      if (extractedData) {
        await fs.writeFile(path.join(jobPath, 'product.json'), JSON.stringify(extractedData, null, 2), 'utf8');
      }

      return {
        status,
        title,
        finalUrl,
        domPath,
        screenshotPath: savedScreenshotPath,
        extractedData,
        error: status === 'requires_auth' ? 'Login or human verification is required.' : null,
      };
    } catch (error) {
      let savedScreenshotPath = null;
      if (screenshotMode !== 'never') {
        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          savedScreenshotPath = screenshotPath;
        } catch { /* preserve the original capture error */ }
      }
      error.captureArtifacts = { screenshotPath: savedScreenshotPath };
      throw error;
    } finally {
      page.off('response', responseHandler);
    }
  }

  function getSessionStatus() {
    return { state: sessionState, lastCheckedAt, browser: lifecycleState, activeOperations };
  }

  // Ephemeral image-only extraction for test/QA flows; it does not create a capture job or save product data.
  async function extractProductImages(url, testId = crypto.randomUUID()) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    sessionState = classifySession(finalUrl, bodyText);
    lastCheckedAt = new Date().toISOString();
    if (sessionState === 'requires_auth') throw new Error('Login or human verification is required.');
    const extractedData = await parse1688Product(page);
    const localImages = await downloadProductImages(extractedData, storagePath, `image-test-${testId}`, context);
    const ordered = localImages.filter((image) => image.type === 'main' || image.type === 'gallery')
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return { offerId: extractedData.offerId, images: ordered };
  }

  // Ephemeral DOM-only product inspection; intentionally does not create jobs, files, or database rows.
  async function inspectProduct(url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    const title = await page.title();
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    sessionState = classifySession(finalUrl, bodyText);
    lastCheckedAt = new Date().toISOString();
    if (sessionState === 'requires_auth') return { status: 'requires_auth', finalUrl, title, data: null };
    const data = await parse1688Product(page);
    return { status: 'completed', finalUrl, title, data };
  }

  // Read image DOM structure for parser diagnostics. This does not save data,
  // download images, click controls, or modify the product record.
  async function inspectProductImageDom(url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const finalUrl = page.url();
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    sessionState = classifySession(finalUrl, bodyText);
    lastCheckedAt = new Date().toISOString();
    if (sessionState === 'requires_auth') return { status: 'requires_auth', finalUrl, images: [] };
    const images = await page.evaluate(() => Array.from(document.images).slice(0, 300).map((image, index) => {
      const sources = {};
      for (const name of ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-origin',
        'data-ks-lazyload', 'data-image', 'data-image-url', 'srcset']) {
        const value = image.getAttribute(name);
        if (value) sources[name] = value;
      }
      const ancestors = [];
      let node = image;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        ancestors.push({ tag: node.tagName, id: node.id || '', className: String(node.className || '').slice(0, 500) });
      }
      const rect = image.getBoundingClientRect();
      return {
        index,
        sources,
        alt: image.alt || '',
        title: image.title || '',
        naturalWidth: image.naturalWidth || 0,
        naturalHeight: image.naturalHeight || 0,
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        ancestors,
      };
    }));
    return { status: 'completed', finalUrl, images };
  }

  // Read product images into memory through the logged-in browser context; no files or jobs are created.
  async function extractProductImagesInMemory(url) {
    const inspected = await inspectProduct(url);
    if (inspected.status !== 'completed') return inspected;
    const data = inspected.data;
    const urls = [...new Set([data.mainImage, ...(data.images || [])].filter(Boolean))];
    const images = [];
    for (const [index, sourceUrl] of urls.entries()) {
      try {
        const response = await context.request.get(sourceUrl, {
          headers: { referer: 'https://detail.1688.com/', 'user-agent': 'Mozilla/5.0' }, timeout: 20000,
        });
        if (!response.ok()) continue;
        const mime = response.headers()['content-type']?.split(';')[0] || 'image/jpeg';
        if (!mime.startsWith('image/')) continue;
        const bytes = await response.body();
        images.push({ type: index === 0 ? 'main' : 'gallery', sortOrder: index, sourceUrl,
          dataUrl: `data:${mime};base64,${bytes.toString('base64')}` });
      } catch { /* a blocked image is omitted from this ephemeral test */ }
    }
    return { status: 'completed', finalUrl: inspected.finalUrl, title: inspected.title,
      offerId: data.offerId, images };
  }

  // Ephemeral SKU audit input: DOM data plus SKU/Gallery image bytes in memory only.
  async function extractProductSkuAuditInput(url) {
    const inspected = await inspectProduct(url);
    if (inspected.status !== 'completed') return inspected;
    const data = inspected.data;
    async function readImage(sourceUrl) {
      if (!sourceUrl) return null;
      try {
        const response = await context.request.get(sourceUrl, {
          headers: { referer: 'https://detail.1688.com/', 'user-agent': 'Mozilla/5.0' }, timeout: 20000,
        });
        if (!response.ok()) return null;
        const mime = response.headers()['content-type']?.split(';')[0] || 'image/jpeg';
        if (!mime.startsWith('image/')) return null;
        const bytes = await response.body();
        return `data:${mime};base64,${bytes.toString('base64')}`;
      } catch { return null; }
    }
    const seenSkuUrls = new Set();
    const skuImageInputs = [];
    for (const [optionIndex, option] of (data.skuOptions || []).entries()) {
      if (!option.image || seenSkuUrls.has(option.image)) continue;
      seenSkuUrls.add(option.image);
      skuImageInputs.push({ kind: 'sku', optionIndex, optionText: option.text || '', sourceUrl: option.image });
    }
    const skuImages = (await Promise.all(skuImageInputs.map(async (item) => ({
      ...item, dataUrl: await readImage(item.sourceUrl),
    })))).filter((item) => item.dataUrl);
    const galleryUrls = [...new Set([data.mainImage, ...(data.images || [])].filter(Boolean))].slice(0, 4);
    const galleryImages = (await Promise.all(galleryUrls.map(async (sourceUrl, index) => ({
      kind: 'gallery', index, sourceUrl, dataUrl: await readImage(sourceUrl),
    })))).filter((item) => item.dataUrl);
    return { status: 'completed', finalUrl: inspected.finalUrl, title: inspected.title,
      offerId: data.offerId, product: data, skuImages, galleryImages };
  }

  return {
    start,
    stop,
    capture: (...args) => withOperation(() => capture(...args)),
    extractProductImages: (...args) => withOperation(() => extractProductImages(...args)),
    extractProductImagesInMemory: (...args) => withOperation(() => extractProductImagesInMemory(...args)),
    extractProductSkuAuditInput: (...args) => withOperation(() => extractProductSkuAuditInput(...args)),
    inspectProduct: (...args) => withOperation(() => inspectProduct(...args)),
    inspectProductImageDom: (...args) => withOperation(() => inspectProductImageDom(...args)),
    getSessionStatus,
  };
}
