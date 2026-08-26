import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startProxyAdapter } from './proxy.js';

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
}) {
  const profilePath = path.join(storagePath, 'browser-profile');
  const capturesPath = path.join(storagePath, 'captures');
  let context;
  let page;
  let proxyAdapter;
  let sessionState = 'unknown';
  let lastCheckedAt = null;

  async function start() {
    await fs.mkdir(profilePath, { recursive: true });
    await fs.mkdir(capturesPath, { recursive: true });
    proxyAdapter = await startProxyAdapter(proxyServer, proxyUsername, proxyPassword);

    context = await chromium.launchPersistentContext(profilePath, {
      headless: true,
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

    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const title = await page.title();
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    sessionState = classifySession(finalUrl, bodyText);
    lastCheckedAt = new Date().toISOString();

    await fs.writeFile(domPath, await page.content(), 'utf8');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      status: sessionState === 'requires_auth' ? 'requires_auth' : 'completed',
      title,
      finalUrl,
      domPath,
      screenshotPath,
      error: sessionState === 'requires_auth' ? 'Login or human verification is required.' : null,
    };
  }

  function getSessionStatus() {
    return { state: sessionState, lastCheckedAt };
  }

  return { start, stop, capture, getSessionStatus };
}
