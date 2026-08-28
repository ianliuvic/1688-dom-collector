import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { createDatabase } from './db.js';
import { createCollector, isAllowed1688Url } from './collector.js';
import { analyzeProductImage } from './vision.js';
import { analyzeGalleryImages, cleanProductGallery } from './image-cleaner.js';

const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  adminApiKey: process.env.ADMIN_API_KEY,
  storagePath: process.env.STORAGE_PATH ?? '/app/storage',
  minCaptureIntervalMs: Number(process.env.MIN_CAPTURE_INTERVAL_MS ?? 15000),
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS ?? 45000),
  proxyServer: process.env.PROXY_SERVER?.trim() || null,
  proxyUsername: process.env.PROXY_USERNAME?.trim() || null,
  proxyPassword: process.env.PROXY_PASSWORD || null,
  browserHeadless: process.env.BROWSER_HEADLESS === 'true',
  screenshotMode: ['never', 'errors', 'always'].includes(process.env.SCREENSHOT_MODE)
    ? process.env.SCREENSHOT_MODE : 'errors',
  clearStaleBrowserLocks: process.env.CLEAR_STALE_BROWSER_LOCKS === 'true',
  dashscopeApiKey: process.env.DASHSCOPE_API_KEY,
  dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL,
  visionModel: process.env.DASHSCOPE_VISION_MODEL || 'qwen3-vl-plus',
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.adminApiKey) throw new Error('ADMIN_API_KEY is required');

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1024 * 1024 });
const db = createDatabase(config.databaseUrl);
const collector = createCollector(config);
let workerRunning = true;

function requireApiKey(request, reply, done) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expected = config.adminApiKey;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  done();
}

app.get('/', async () => ({
  name: '1688 DOM Collector',
  status: 'framework-ready',
  session: collector.getSessionStatus(),
}));

app.get('/health', async (_request, reply) => {
  try {
    await db.ping();
    return { ok: true };
  } catch (error) {
    reply.code(503);
    return { ok: false, error: error.message };
  }
});

app.get('/api/session', { preHandler: requireApiKey }, async () => collector.getSessionStatus());

app.get('/api/shops', { preHandler: requireApiKey }, async (request) => {
  return db.listShopProfiles(request.query?.limit);
});

app.get('/api/shops/:id/products', { preHandler: requireApiKey }, async (request) => {
  return db.listShopProducts(request.params.id, request.query?.limit);
});

app.post('/api/product-details', { preHandler: requireApiKey }, async (request, reply) => {
  const suppliedUrl = request.body?.url;
  const offerId = request.body?.offerId;
  let url = suppliedUrl;
  if (!url && typeof offerId === 'string' && /^\d{10,13}$/.test(offerId)) {
    url = `https://detail.1688.com/offer/${offerId}.html`;
  }
  if (typeof url !== 'string' || !isAllowed1688Url(url)
      || !new URL(url).hostname.startsWith('detail.')) {
    return reply.code(400).send({ error: 'Provide a valid HTTPS 1688 detail URL or offerId.' });
  }
  const job = await db.createJob(crypto.randomUUID(), url, { mode: 'product_detail' });
  return reply.code(202).send(job);
});

app.get('/api/product-details/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  return detail ?? reply.code(404).send({ error: 'not_found' });
});

app.post('/api/product-details/:id/vision', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const firstImage = detail.images.find((image) => image.image_type === 'main')
    ?? detail.images[0];
  if (!firstImage?.storage_path) return reply.code(409).send({ error: 'no_local_image' });
  try {
    const result = await analyzeProductImage({
      imagePath: firstImage.storage_path, sourceUrl: firstImage.source_url,
      offerId: detail.offer_id, prompt: request.body?.prompt, config: {
        apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
        model: config.visionModel, storagePath: config.storagePath,
      },
    });
    const saved = await db.saveProductVision(detail.id, firstImage.id, result);
    return { ...saved, analysis: result };
  } catch (error) {
    request.log.error({ err: error, productDetailId: detail.id }, 'vision analysis failed');
    return reply.code(502).send({ error: 'vision_analysis_failed', message: error.message });
  }
});

app.get('/api/product-details/:id/vision', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return db.listProductVision(detail.id);
});

app.post('/api/product-details/:id/image-clean', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  try {
    const result = await cleanProductGallery({ detail, config: {
      apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
      model: config.visionModel, storagePath: config.storagePath,
    } });
    const saved = await db.saveProductImageCleanup(detail.id, result);
    return { cleanupId: saved.id, ...result, createdAt: saved.created_at };
  } catch (error) {
    request.log.error({ err: error, productDetailId: detail.id }, 'gallery cleaning failed');
    return reply.code(502).send({ error: 'image_clean_failed', message: error.message });
  }
});

app.get('/api/product-details/:id/image-clean', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return db.listProductImageCleanups(detail.id);
});

app.post('/api/image-clean/test', { preHandler: requireApiKey }, async (request, reply) => {
  if (!Array.isArray(request.body?.images) || request.body.images.length < 1 || request.body.images.length > 30) {
    return reply.code(400).send({ error: 'images must contain 1 to 30 ordered persistent-storage image paths.' });
  }
  try {
    return await analyzeGalleryImages({ images: request.body.images, persistOutput: false, config: {
      apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
      model: config.visionModel, storagePath: config.storagePath,
    } });
  } catch (error) {
    request.log.error({ err: error }, 'test gallery cleaning failed');
    return reply.code(502).send({ error: 'image_clean_test_failed', message: error.message });
  }
});

app.post('/api/plugin-session/check', { preHandler: requireApiKey }, async (_request, reply) => {
  const job = await db.createJob(
    crypto.randomUUID(),
    'https://air.1688.com/',
    { mode: 'plugin_login' },
  );
  return reply.code(202).send(job);
});

app.post('/api/shop-contact-link', { preHandler: requireApiKey }, async (request, reply) => {
  const url = request.body?.url;
  if (typeof url !== 'string' || !isAllowed1688Url(url)) {
    return reply.code(400).send({ error: 'A valid HTTPS 1688 shop URL is required.' });
  }
  const job = await db.createJob(crypto.randomUUID(), url, { mode: 'shop_contact' });
  return reply.code(202).send(job);
});

app.post('/api/jobs', { preHandler: requireApiKey }, async (request, reply) => {
  const url = request.body?.url;
  if (typeof url !== 'string' || !isAllowed1688Url(url)) {
    return reply.code(400).send({ error: 'A valid HTTPS URL under 1688.com is required.' });
  }
  if (request.body?.paginate !== undefined && typeof request.body.paginate !== 'boolean') {
    return reply.code(400).send({ error: 'paginate must be a boolean when provided.' });
  }
  const job = await db.createJob(crypto.randomUUID(), url, {
    paginate: request.body?.paginate === true,
  });
  return reply.code(202).send(job);
});

app.post('/api/shop-scans', { preHandler: requireApiKey }, async (request, reply) => {
  const url = request.body?.url;
  const memberId = request.body?.memberId;
  const pageNum = request.body?.pageNum ?? 1;
  const pageSize = request.body?.pageSize ?? 300;
  const sortType = request.body?.sortType ?? 'wangpu_score';
  const allPages = request.body?.allPages === true;
  const maxPages = request.body?.maxPages ?? 1000;
  if (typeof url !== 'string' || !isAllowed1688Url(url)
      || !new URL(url).hostname.startsWith('shop')) {
    return reply.code(400).send({ error: 'A valid HTTPS 1688 shop URL is required.' });
  }
  if (memberId !== undefined
      && (typeof memberId !== 'string' || !/^b2b-[a-z0-9-]{5,80}$/i.test(memberId))) {
    return reply.code(400).send({ error: 'memberId must be a valid 1688 memberId when provided.' });
  }
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > 10000) {
    return reply.code(400).send({ error: 'pageNum must be an integer between 1 and 10000.' });
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 300) {
    return reply.code(400).send({ error: 'pageSize must be an integer between 1 and 300.' });
  }
  if (typeof sortType !== 'string' || !/^[a-z0-9_]{1,40}$/i.test(sortType)) {
    return reply.code(400).send({ error: 'sortType is invalid.' });
  }
  if (request.body?.allPages !== undefined && typeof request.body.allPages !== 'boolean') {
    return reply.code(400).send({ error: 'allPages must be a boolean when provided.' });
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    return reply.code(400).send({ error: 'maxPages must be an integer between 1 and 1000.' });
  }
  const job = await db.createJob(crypto.randomUUID(), url, {
    mode: 'shop_mtop', memberId, pageNum, pageSize, sortType, allPages, maxPages,
  });
  return reply.code(202).send(job);
});

app.post('/api/shop-scans/all', { preHandler: requireApiKey }, async (request, reply) => {
  const url = request.body?.url;
  if (typeof url !== 'string' || !isAllowed1688Url(url)
      || !new URL(url).hostname.startsWith('shop')) {
    return reply.code(400).send({ error: 'A valid HTTPS 1688 shop URL is required.' });
  }
  const job = await db.createJob(crypto.randomUUID(), url, {
    mode: 'shop_mtop', allPages: true, pageNum: 1, pageSize: 300,
    sortType: 'wangpu_score', maxPages: 1000,
  });
  return reply.code(202).send(job);
});

app.get('/api/jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = await db.getJob(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

app.get('/api/jobs/:id/dom', { preHandler: requireApiKey }, async (request, reply) => {
  const job = await db.getJob(request.params.id);
  if (!job) return reply.code(404).send({ error: 'not_found' });
  if (!job.dom_path) return reply.code(409).send({ error: 'dom_not_available' });
  const capturesRoot = path.resolve(config.storagePath, 'captures');
  const domPath = path.resolve(job.dom_path);
  if (!domPath.startsWith(`${capturesRoot}${path.sep}`)) {
    return reply.code(500).send({ error: 'invalid_dom_path' });
  }
  try {
    return reply.type('text/html; charset=utf-8').send(await fs.readFile(domPath));
  } catch (error) {
    if (error.code === 'ENOENT') return reply.code(404).send({ error: 'dom_file_not_found' });
    throw error;
  }
});

async function workerLoop() {
  while (workerRunning) {
    const job = await db.claimNextJob();
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    try {
      const result = await collector.capture(job);
      await db.completeJob(job.id, result);
      if (result.extractedData?.pageType === 'shop') {
        await db.upsertShopProfile(result.extractedData);
      } else if (result.extractedData?.pageType === 'shop-offer-collection') {
        await db.saveShopScan(job.id, result.extractedData);
      } else if (job.options?.mode === 'product_detail'
          && result.extractedData?.pageType === 'product') {
        await db.saveProductDetail(result.extractedData, job.url, result.extractedData.localImages ?? []);
      }
    } catch (error) {
      app.log.error({ err: error, jobId: job.id }, 'capture failed');
      await db.completeJob(job.id, {
        status: 'failed', title: null, finalUrl: null, domPath: null,
        screenshotPath: error.captureArtifacts?.screenshotPath ?? null,
        extractedData: null, error: error.message,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, config.minCaptureIntervalMs));
  }
}

async function shutdown() {
  workerRunning = false;
  await collector.stop();
  await db.pool.end();
  await app.close();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await db.migrate();
await collector.start();
await app.listen({ port: config.port, host: '0.0.0.0' });
workerLoop().catch((error) => {
  app.log.fatal(error, 'worker stopped');
  process.exitCode = 1;
});
