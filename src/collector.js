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

export function isAllowed1688Url(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === '1688.com' || url.hostname.endsWith('.1688.com'));
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
  let sessionState = 'unknown';
  let lastCheckedAt = null;
  const pluginCrypto = createPluginCrypto({ storagePath, refreshToken: refreshPluginHeartbeat });

  async function start() {
    await fs.mkdir(profilePath, { recursive: true });
    await fs.mkdir(capturesPath, { recursive: true });
    if (clearStaleBrowserLocks) {
      await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map((name) =>
        fs.rm(path.join(profilePath, name), { force: true, recursive: true })));
    }
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
  }

  async function stop() {
    await context?.close();
    await proxyAdapter?.close();
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
      const isShopPage = new URL(page.url()).hostname.startsWith('shop');
      await page.waitForTimeout(isShopPage ? 8000 : 3000);
      if (job.options?.paginate === true
          && isShopPage && new URL(page.url()).pathname.includes('offerlist')) {
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
    return { state: sessionState, lastCheckedAt };
  }

  return { start, stop, capture, getSessionStatus };
}
