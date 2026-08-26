const { chromium } = require('playwright');

const profilePath = process.env.PROFILE_PATH || '/app/storage/browser-profile';
const proxyServer = process.env.PROXY_SERVER?.trim();
const proxyUsername = process.env.PROXY_USERNAME?.trim();
const proxyPassword = process.env.PROXY_PASSWORD;

const proxy = proxyServer
  ? {
      server: proxyServer,
      ...(proxyUsername ? { username: proxyUsername } : {}),
      ...(proxyPassword ? { password: proxyPassword } : {}),
    }
  : undefined;

let context;

async function shutdown() {
  await context?.close().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1400, height: 940 },
    args: ['--disable-dev-shm-usage', '--password-store=basic'],
    ...(proxy ? { proxy } : {}),
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.1688.com/', { waitUntil: 'domcontentloaded' });
  console.log(`Login browser ready. Proxy enabled: ${Boolean(proxy)}`);
})().catch((error) => {
  console.error('Login browser failed to start:', error.message);
  process.exit(1);
});
