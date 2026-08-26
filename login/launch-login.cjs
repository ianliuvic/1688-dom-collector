const { chromium } = require('playwright');
const { Server: ProxyChainServer } = require('proxy-chain');

const profilePath = process.env.PROFILE_PATH || '/app/storage/browser-profile';
const proxyServer = process.env.PROXY_SERVER?.trim();
const proxyUsername = process.env.PROXY_USERNAME?.trim();
const proxyPassword = process.env.PROXY_PASSWORD;
const startUrl = process.env.START_URL || 'https://login.1688.com/member/signin.htm';

let context;
let proxyAdapter;

async function startProxyAdapter() {
  if (!proxyServer) return null;

  const upstream = new URL(proxyServer);
  if (proxyUsername) upstream.username = proxyUsername;
  if (proxyPassword) upstream.password = proxyPassword;

  const adapter = new ProxyChainServer({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({ upstreamProxyUrl: upstream.toString() }),
  });
  await adapter.listen();
  return adapter;
}

async function shutdown() {
  await context?.close().catch(() => {});
  await proxyAdapter?.close(true).catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  proxyAdapter = await startProxyAdapter();
  context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1400, height: 940 },
    args: ['--disable-dev-shm-usage', '--password-store=basic'],
    ...(proxyAdapter
      ? { proxy: { server: `http://127.0.0.1:${proxyAdapter.port}` } }
      : {}),
  });

  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    console.warn('Initial proxy connectivity page failed:', error.message);
  }
  console.log(`Login browser ready. Proxy enabled: ${Boolean(proxyAdapter)}`);
})().catch((error) => {
  console.error('Login browser failed to start:', error.message);
  process.exit(1);
});
