import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyHttpProxy from '@fastify/http-proxy';
import { createDatabase } from './db.js';
import { createCollector, isAllowed1688Url } from './collector.js';
import { analyzeProductImage } from './vision.js';
import { analyzeGalleryImages, auditProductGallery } from './image-cleaner.js';
import { auditProductSkus } from './sku-auditor.js';
import { translateProductDetail } from './product-translator.js';
import { prepareWordPressProductDraft, publishProductToWordPress,
  setWordPressProductPublicationDate, syncWordPressProductPricing } from './wordpress-publisher.js';
import { createLoginManager } from './login-manager.js';
import { createConcurrentQueue } from './concurrent-queue.js';
import { buildRagProduct, createRagClient } from './rag-client.js';
import { analyzeProductDuplicates } from './duplicate-analyzer.js';

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
  visionModel: process.env.DASHSCOPE_VISION_MODEL || 'qwen3.8-max',
  complexModel: process.env.DASHSCOPE_COMPLEX_MODEL || 'qwen3.8-max',
  translationImageLimit: Math.min(Math.max(Number(process.env.TRANSLATION_IMAGE_LIMIT) || 6, 1), 8),
  translationConcurrency: Math.min(Math.max(Number(process.env.TRANSLATION_CONCURRENCY) || 1, 1), 10),
  modelImageTransport: process.env.MODEL_IMAGE_TRANSPORT === 'persistent_storage'
    ? 'persistent_storage' : 'source_url',
  wordpressBaseUrl: process.env.WORDPRESS_BASE_URL,
  wordpressUsername: process.env.WORDPRESS_USERNAME,
  wordpressApplicationPassword: process.env.WORDPRESS_APPLICATION_PASSWORD,
  novncUsername: process.env.NOVNC_USERNAME || '',
  novncPassword: process.env.NOVNC_PASSWORD || '',
  productsRagApiUrl: process.env.PRODUCTS_RAG_API_URL || '',
  productsRagAdminToken: process.env.PRODUCTS_RAG_ADMIN_TOKEN || '',
  productsRagSyncConcurrency: Math.min(Math.max(Number(process.env.PRODUCTS_RAG_SYNC_CONCURRENCY) || 2, 1), 5),
};

if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.adminApiKey) throw new Error('ADMIN_API_KEY is required');

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1024 * 1024 });
const db = createDatabase(config.databaseUrl);
const collector = createCollector(config);
const loginManager = createLoginManager(config);
const ragClient = createRagClient(config);
let workerRunning = true;
let workerEnabled = true;
let workerActive = false;
let browserMode = 'collector';
let browserTransition = null;
let modeSwitchQueue = Promise.resolve();
const skuAuditJobs = new Map();
const imageAuditJobs = new Map();
const translationJobs = new Map();
const wordpressJobs = new Map();
const wordpressPublicationDateJobs = new Map();
const wordpressPriceRepairJobs = new Map();
let multimodalAuditQueue = Promise.resolve();
const translationQueue = createConcurrentQueue({
  concurrency: config.translationConcurrency,
  onTaskError: (error) => app.log.error({ err: error }, 'unhandled translation queue error'),
});
const ragSyncQueue = createConcurrentQueue({
  concurrency: config.productsRagSyncConcurrency,
  onTaskError: (error) => app.log.error({ err: error }, 'unhandled products RAG sync error'),
});
let wordpressQueue = Promise.resolve();

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

function requireCollectorMode(_request, reply, done) {
  if (browserMode !== 'collector' || browserTransition) {
    reply.code(409).send({ error: 'collector_unavailable', browserMode, transition: browserTransition });
    return;
  }
  done();
}

function requireNovncAuth(request, reply, done) {
  if (!config.novncUsername || !config.novncPassword) {
    reply.code(503).send({ error: 'novnc_credentials_not_configured' });
    return;
  }
  const encoded = request.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1] || '';
  let supplied = '';
  try { supplied = Buffer.from(encoded, 'base64').toString('utf8'); } catch { /* invalid Basic auth */ }
  const expected = `${config.novncUsername}:${config.novncPassword}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    reply.header('WWW-Authenticate', 'Basic realm="1688 Login"');
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  if (browserMode !== 'login' || browserTransition) {
    reply.code(409).send({ error: 'login_mode_inactive', browserMode, transition: browserTransition });
    return;
  }
  done();
}

async function waitForWorkerIdle() {
  while (workerActive) await new Promise((resolve) => setTimeout(resolve, 100));
}

async function performBrowserModeSwitch(target) {
  if (!['collector', 'login'].includes(target)) throw new Error(`Unsupported browser mode: ${target}`);
  if (browserMode === target && !browserTransition) return getBrowserModeStatus();
  browserTransition = `${browserMode}_to_${target}`;
  if (target === 'login') {
    workerEnabled = false;
    await waitForWorkerIdle();
    try {
      await collector.stop();
      await loginManager.start();
      browserMode = 'login';
    } catch (error) {
      await loginManager.stop().catch(() => {});
      await collector.start();
      workerEnabled = true;
      browserTransition = null;
      throw error;
    }
  } else {
    try {
      await loginManager.stop();
      await collector.start();
      browserMode = 'collector';
      workerEnabled = true;
    } catch (error) {
      browserTransition = null;
      throw error;
    }
  }
  browserTransition = null;
  return getBrowserModeStatus();
}

function switchBrowserMode(target) {
  const operation = modeSwitchQueue.catch(() => {}).then(() => performBrowserModeSwitch(target));
  modeSwitchQueue = operation;
  return operation;
}

function getBrowserModeStatus() {
  return {
    mode: browserMode,
    transition: browserTransition,
    workerEnabled,
    workerActive,
    collector: collector.getSessionStatus(),
    login: loginManager.getStatus(),
    loginUrl: `https://${process.env.LOGIN_PUBLIC_HOST || 'collector.yiswim.cloud'}/login/vnc.html?autoconnect=1&resize=remote&path=login/websockify`,
  };
}

function auditModelConfig() {
  return {
    apiKey: config.dashscopeApiKey,
    baseUrl: config.dashscopeBaseUrl,
    visionModel: config.visionModel,
    complexModel: config.complexModel,
    storagePath: config.storagePath,
  };
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function imageDataUrl(image) {
  if (!image?.storage_path) return null;
  const storageRoot = path.resolve(config.storagePath);
  const imagePath = path.resolve(image.storage_path);
  if (!imagePath.startsWith(`${storageRoot}${path.sep}`)) return null;
  try {
    const bytes = await fs.readFile(imagePath);
    const mime = image.mime_type || ({ '.png': 'image/png', '.webp': 'image/webp',
      '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(imagePath).toLowerCase()]
      || 'image/jpeg';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function normalizedImageUrl(value) {
  return String(value || '').trim().replace(/^http:/, 'https:').replace(/[?#].*$/, '');
}

async function cleanupRejectedProductImages(imageFiles = []) {
  const storageRoot = path.resolve(config.storagePath);
  const productImageRoot = path.resolve(config.storagePath, 'product-images');
  const parents = new Set();
  for (const image of imageFiles) {
    if (!image?.storagePath) continue;
    const filePath = path.resolve(image.storagePath);
    if (!filePath.startsWith(`${productImageRoot}${path.sep}`)
        || !filePath.startsWith(`${storageRoot}${path.sep}`)) continue;
    await fs.unlink(filePath).catch(() => {});
    parents.add(path.dirname(filePath));
  }
  for (const parent of parents) await fs.rmdir(parent).catch(() => {});
}

async function savedSkuAuditInput(detail) {
  const raw = detail.raw_data ?? {};
  const skuOptions = Array.isArray(raw.skuOptions) ? raw.skuOptions : [];
  const skuFiles = (detail.images ?? []).filter((image) => image.image_type === 'sku');
  const skuByUrl = new Map(skuFiles.map((image) => [normalizedImageUrl(image.source_url), image]));
  const skuImages = [];
  const seen = new Set();
  for (const [optionIndex, option] of skuOptions.entries()) {
    const sourceUrl = option.image || option.imageUrl || null;
    const key = normalizedImageUrl(sourceUrl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const stored = skuByUrl.get(key) ?? null;
    const dataUrl = await imageDataUrl(stored);
    if (dataUrl) skuImages.push({ kind: 'sku', optionIndex, optionText: option.text || '', sourceUrl, dataUrl });
  }
  const galleryRows = (detail.images ?? []).filter((image) => ['main', 'gallery'].includes(image.image_type))
    .sort((a, b) => {
      if (a.image_type === 'main') return -1;
      if (b.image_type === 'main') return 1;
      return Number(a.sort_order || 0) - Number(b.sort_order || 0);
    }).slice(0, 4);
  const galleryImages = [];
  for (const [index, image] of galleryRows.entries()) {
    const dataUrl = await imageDataUrl(image);
    if (dataUrl) galleryImages.push({ kind: 'gallery', index, sourceUrl: image.source_url, dataUrl });
  }
  const product = {
    ...raw,
    offerId: raw.offerId ?? detail.offer_id,
    title: raw.title ?? detail.title,
    skuOptions: skuOptions.map((option) => ({ ...option, image: option.image || option.imageUrl || null })),
    skuRows: Array.isArray(raw.skuRows) && raw.skuRows.length ? raw.skuRows
      : (detail.skus ?? []).map((sku) => ({ skuKey: sku.sku_key, skuText: sku.sku_text,
        price: sku.price, stock: sku.stock, options: sku.option_data ?? {} })),
  };
  return { product, skuImages, galleryImages };
}

async function executeSavedProductAudits(productDetailId, records) {
  const results = {};
  let detail;
  try {
    detail = await db.getProductDetail(productDetailId);
    if (!detail) throw new Error('Saved product detail no longer exists.');
  } catch (error) {
    if (records.image) await db.failProductAudit('image', records.image.id, error).catch(() => {});
    if (records.sku) await db.failProductAudit('sku', records.sku.id, error).catch(() => {});
    return {
      ...(records.image ? { image: { error: error.message } } : {}),
      ...(records.sku ? { sku: { error: error.message } } : {}),
    };
  }
  if (records.image) {
    try {
      await db.startProductAudit('image', records.image.id);
      const result = await auditProductGallery({ detail, config: auditModelConfig() });
      const sourceHash = hashJson((result.images ?? []).map((image) => ({
        index: image.index, sha256: image.sha256, sourceUrl: image.sourceUrl,
      })));
      results.image = { record: await db.completeProductAudit('image', records.image.id, result, sourceHash), result };
    } catch (error) {
      await db.failProductAudit('image', records.image.id, error);
      results.image = { error: error.message };
    }
  }
  if (records.sku) {
    try {
      await db.startProductAudit('sku', records.sku.id);
      const input = await savedSkuAuditInput(detail);
      const sourceHash = hashJson({
        skuDimensions: input.product.skuDimensions ?? [], skuOptions: input.product.skuOptions ?? [],
        skuRows: input.product.skuRows ?? [], skuImageUrls: input.skuImages.map((image) => image.sourceUrl),
        galleryUrls: input.galleryImages.map((image) => image.sourceUrl),
      });
      const result = await auditProductSkus({ ...input, config: auditModelConfig() });
      results.sku = { record: await db.completeProductAudit('sku', records.sku.id, result, sourceHash), result };
    } catch (error) {
      await db.failProductAudit('sku', records.sku.id, error);
      results.sku = { error: error.message };
    }
  }
  return results;
}

async function scheduleSavedProductAudits(productDetailId, { trigger = 'manual', types = ['image', 'sku'] } = {}) {
  const records = {};
  if (types.includes('image')) records.image = await db.createProductAudit('image', productDetailId,
    { trigger, model: config.complexModel });
  if (types.includes('sku')) records.sku = await db.createProductAudit('sku', productDetailId,
    { trigger, model: config.complexModel });
  const operation = multimodalAuditQueue.catch(() => {})
    .then(() => executeSavedProductAudits(productDetailId, records));
  multimodalAuditQueue = operation.catch((error) => {
    app.log.error({ err: error, productDetailId }, 'saved product audits failed');
  });
  return { records, operation };
}

async function executeProductRagSync(record) {
  await db.startProductRagSync(record.id);
  try {
    const detail = await db.getProductDetail(record.product_detail_id);
    if (!detail) throw new Error('Saved product detail no longer exists.');
    const [translation, publication] = await Promise.all([
      db.getLatestProductTranslation(detail.id, 'en'),
      db.getWordPressPublication(detail.id),
    ]);
    const product = buildRagProduct({ detail, translation, publication });
    const response = await ragClient.upsert(product);
    const result = response?.results?.[0];
    if (!response?.ok || result?.ok === false) {
      throw new Error(result?.error || 'Products RAG API rejected the product.');
    }
    await db.completeProductRagSync(record.id, {
      canonicalProductId: product.canonicalProductId, active: product.active,
      responseSummary: {
        entities: result?.entities ?? null, productEntities: result?.productEntities ?? null,
        galleryEntities: result?.galleryEntities ?? null, skuEntities: result?.skuEntities ?? null,
      },
    });
    return response;
  } catch (error) {
    await db.failProductRagSync(record.id, error).catch(() => {});
    throw error;
  }
}

async function scheduleProductRagSync(productDetailId, { trigger = 'manual' } = {}) {
  if (!ragClient.enabled) return { scheduled: false, reason: 'not_configured' };
  const detail = await db.getProductDetail(productDetailId);
  if (!detail) throw new Error('Saved product detail no longer exists.');
  const record = await db.createProductRagSync(productDetailId, {
    trigger, canonicalProductId: `1688:${detail.offer_id}`,
    requestSummary: { sourceProductId: String(detail.offer_id), trigger },
  });
  ragSyncQueue.enqueue(() => executeProductRagSync(record));
  return { scheduled: true, recordId: record.id };
}

app.register(fastifyHttpProxy, {
  upstream: 'http://127.0.0.1:6080',
  prefix: '/login',
  rewritePrefix: '',
  websocket: true,
  preHandler: requireNovncAuth,
});

app.get('/', async () => ({
  name: '1688 DOM Collector',
  status: 'framework-ready',
  browserMode: getBrowserModeStatus(),
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

app.get('/api/browser-mode', { preHandler: requireApiKey }, async () => getBrowserModeStatus());

app.post('/api/browser-mode/login', { preHandler: requireApiKey }, async (request, reply) => {
  try {
    return await switchBrowserMode('login');
  } catch (error) {
    request.log.error({ err: error }, 'failed to enter login mode');
    return reply.code(500).send({ error: 'login_mode_failed', message: error.message });
  }
});

app.post('/api/browser-mode/collector', { preHandler: requireApiKey }, async (request, reply) => {
  try {
    return await switchBrowserMode('collector');
  } catch (error) {
    request.log.error({ err: error }, 'failed to enter collector mode');
    return reply.code(500).send({ error: 'collector_mode_failed', message: error.message });
  }
});

app.get('/api/shops', { preHandler: requireApiKey }, async (request) => {
  return db.listShopProfiles(request.query?.limit);
});

app.get('/api/shops/:id/products', { preHandler: requireApiKey }, async (request) => {
  return db.listShopProducts(request.params.id, request.query?.limit);
});

app.post('/api/product-details', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
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

app.post('/api/product-details/test', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
  const url = request.body?.url;
  if (typeof url !== 'string' || !isAllowed1688Url(url)
      || !new URL(url).hostname.startsWith('detail.')) {
    return reply.code(400).send({ error: 'Provide a valid HTTPS 1688 detail URL.' });
  }
  try {
    return await collector.inspectProduct(url);
  } catch (error) {
    request.log.error({ err: error }, 'ephemeral product inspection failed');
    return reply.code(502).send({ error: 'product_inspection_failed', message: error.message });
  }
});

app.get('/api/product-details', { preHandler: requireApiKey }, async (request, reply) => {
  const offerId = request.query?.offerId || null;
  if (offerId && !/^\d{10,13}$/.test(String(offerId))) {
    return reply.code(400).send({ error: 'offerId must be a 10 to 13 digit number.' });
  }
  return db.listProductDetails({ offerId, limit: request.query?.limit });
});

app.get('/api/product-details/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  return detail ?? reply.code(404).send({ error: 'not_found' });
});

app.post('/api/product-details/:id/translations', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const targetLanguage = request.body?.targetLanguage || 'en';
  const preserveCatalogCopy = request.body?.preserveCatalogCopy === true;
  if (targetLanguage !== 'en') {
    return reply.code(400).send({ error: 'Only targetLanguage=en is currently supported.' });
  }
  const previousTranslation = preserveCatalogCopy
    ? await db.getLatestProductTranslation(detail.id, targetLanguage) : null;
  const id = crypto.randomUUID();
  const job = { id, productDetailId: detail.id, offerId: detail.offer_id, targetLanguage,
    model: config.complexModel, status: 'queued', createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, translationId: null, result: null, error: null };
  translationJobs.set(id, job);
  while (translationJobs.size > 100) translationJobs.delete(translationJobs.keys().next().value);
  translationQueue.enqueue(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const translated = await translateProductDetail({ detail, targetLanguage, config: {
        apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
        complexModel: config.complexModel, storagePath: config.storagePath,
        maxTranslationImages: config.translationImageLimit,
        modelImageTransport: config.modelImageTransport,
      } });
      if (previousTranslation) {
        translated.translated.title = previousTranslation.title;
        translated.translated.description = previousTranslation.description;
        translated.namingStrategy = 'preserved_catalog_copy_sku_refresh';
      }
      const saved = await db.saveProductTranslation(detail.id, translated);
      await scheduleProductRagSync(detail.id, { trigger: 'translation' });
      job.translationId = saved.id;
      job.result = saved;
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
    } finally {
      job.completedAt = new Date().toISOString();
    }
  });
  return reply.code(202).send(job);
});

app.get('/api/product-details/:id/translations', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const targetLanguage = request.query?.targetLanguage || null;
  if (targetLanguage && targetLanguage !== 'en') {
    return reply.code(400).send({ error: 'Only targetLanguage=en is currently supported.' });
  }
  return db.listProductTranslations(detail.id, targetLanguage);
});

app.get('/api/translation-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = translationJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

function wordpressPublishOptions(body = {}) {
  const allowedStatuses = new Set(['draft', 'pending', 'publish', 'private']);
  const status = allowedStatuses.has(body.status) ? body.status : 'draft';
  return {
    status,
    styleNo: typeof body.styleNo === 'string' ? body.styleNo : '',
    categoryIds: Array.isArray(body.categoryIds) ? body.categoryIds : [],
    tagIds: Array.isArray(body.tagIds) ? body.tagIds : [],
    tags: Array.isArray(body.tags) ? body.tags : [],
    categoryMode: ['auto', 'primary_only', 'manual'].includes(body.categoryMode) ? body.categoryMode : '',
    tagMode: ['auto', 'manual'].includes(body.tagMode) ? body.tagMode : '',
    primaryCategoryId: Number(body.primaryCategoryId) || 0,
    material: typeof body.material === 'string' ? body.material : '',
    imageMode: body.imageMode === 'main_only' ? 'main_only' : 'translated',
  };
}

app.post('/api/product-details/:id/gallery-debug', {
  preHandler: [requireApiKey, requireCollectorMode],
}, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  try {
    return await collector.inspectProductImageDom(detail.source_url);
  } catch (error) {
    request.log.error({ err: error, productDetailId: detail.id }, 'Gallery DOM inspection failed');
    return reply.code(502).send({ error: 'gallery_debug_failed', message: error.message });
  }
});

app.get('/api/product-details/:id/wordpress', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return db.getWordPressPublication(detail.id);
});

app.post('/api/product-details/:id/wordpress/preview', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const translation = await db.getLatestProductTranslation(detail.id, 'en');
  if (!translation) return reply.code(409).send({ error: 'english_translation_required' });
  try {
    const draft = await prepareWordPressProductDraft({
      detail, translation, options: wordpressPublishOptions(request.body), config,
    });
    return { payload: draft.payload, publishingImageCount: draft.publishingImages.length };
  } catch (error) {
    return reply.code(422).send({ error: 'wordpress_payload_failed', message: error.message });
  }
});

app.post('/api/product-details/:id/wordpress/publish', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const translation = await db.getLatestProductTranslation(detail.id, 'en');
  if (!translation) return reply.code(409).send({ error: 'english_translation_required' });
  const id = crypto.randomUUID();
  const options = wordpressPublishOptions(request.body);
  const job = { id, productDetailId: detail.id, offerId: detail.offer_id,
    status: 'queued', publishStatus: options.status, createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, publicationId: null, result: null, error: null };
  wordpressJobs.set(id, job);
  while (wordpressJobs.size > 100) wordpressJobs.delete(wordpressJobs.keys().next().value);
  wordpressQueue = wordpressQueue.catch(() => {}).then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    let draft;
    try {
      const published = await publishProductToWordPress({ detail, translation, options, config });
      draft = published.draft;
      const wp = published.wordpress;
      const syncHash = crypto.createHash('sha256').update(JSON.stringify(published.payload)).digest('hex');
      const saved = await db.saveWordPressPublication(detail.id, {
        translationId: translation.id, externalId: draft.externalId, styleNo: draft.styleNo,
        wpPostId: wp.post_id ?? null, wpUrl: wp.permalink ?? null, wpEditUrl: wp.edit_link ?? null,
        wpStatus: wp.status ?? options.status, syncHash, payload: published.payload, result: wp,
        lastError: null,
      });
      await scheduleProductRagSync(detail.id, { trigger: 'wordpress_publish' });
      job.publicationId = saved.id;
      job.result = { publication: saved, wordpress: wp, mediaCount: published.media.length };
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      if (draft) {
        await db.saveWordPressPublication(detail.id, {
          translationId: translation.id, externalId: draft.externalId, styleNo: draft.styleNo,
          payload: draft.payload, result: {}, lastError: error.message,
        }).catch(() => {});
      }
    } finally {
      job.completedAt = new Date().toISOString();
    }
  });
  return reply.code(202).send(job);
});

app.get('/api/wordpress-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = wordpressJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

app.get('/api/product-details/:id/rag-syncs', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return db.listProductRagSyncs(detail.id, request.query?.limit);
});

app.post('/api/product-details/:id/rag-sync', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const scheduled = await scheduleProductRagSync(detail.id, { trigger: 'manual' });
  return reply.code(scheduled.scheduled ? 202 : 503).send(scheduled);
});

app.post('/api/wordpress/publication-dates/backfill', { preHandler: requireApiKey }, async (_request, reply) => {
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', total: 0, updated: 0, failed: 0,
    from1688ListingTime: 0, fromFirstSeenAt: 0,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null, errors: [] };
  wordpressPublicationDateJobs.set(id, job);
  while (wordpressPublicationDateJobs.size > 100) {
    wordpressPublicationDateJobs.delete(wordpressPublicationDateJobs.keys().next().value);
  }
  wordpressQueue = wordpressQueue.catch(() => {}).then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const rows = await db.listWordPressPublicationDates();
      job.total = rows.length;
      for (let offset = 0; offset < rows.length; offset += 5) {
        const batch = rows.slice(offset, offset + 5);
        await Promise.all(batch.map(async (row) => {
          try {
            await setWordPressProductPublicationDate({
              postId: row.wp_post_id, publicationDate: row.publication_date, config,
            });
            job.updated += 1;
            if (row.publication_date_source === '1688_listing_time') job.from1688ListingTime += 1;
            else job.fromFirstSeenAt += 1;
          } catch (error) {
            job.failed += 1;
            job.errors.push({ productDetailId: row.product_detail_id, message: error.message });
          }
        }));
      }
      job.status = job.failed ? 'completed_with_errors' : 'completed';
    } catch (error) {
      job.status = 'failed';
      job.errors.push({ message: error.message });
    } finally {
      job.completedAt = new Date().toISOString();
    }
  });
  return reply.code(202).send(job);
});

app.get('/api/wordpress-publication-date-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = wordpressPublicationDateJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

app.post('/api/wordpress/prices/audit-and-repair', { preHandler: requireApiKey }, async (_request, reply) => {
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', total: 0, verified: 0, unresolved: 0,
    storedChanged: 0, publishedAffected: 0, wordpressUpdated: 0, failed: 0,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null, errors: [] };
  wordpressPriceRepairJobs.set(id, job);
  while (wordpressPriceRepairJobs.size > 100) {
    wordpressPriceRepairJobs.delete(wordpressPriceRepairJobs.keys().next().value);
  }
  wordpressQueue = wordpressQueue.catch(() => {}).then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const audit = await db.auditAndRepairProductPrices();
      job.total = audit.total;
      job.verified = audit.verified;
      job.unresolved = audit.unresolved;
      job.storedChanged = audit.changed;
      const affected = audit.items.filter((item) => item.needsWordPressSync);
      job.publishedAffected = affected.length;
      for (let offset = 0; offset < affected.length; offset += 5) {
        const batch = affected.slice(offset, offset + 5);
        await Promise.all(batch.map(async (item) => {
          try {
            const [detail, publication] = await Promise.all([
              db.getProductDetail(item.productDetailId),
              db.getWordPressPublication(item.productDetailId),
            ]);
            const synced = await syncWordPressProductPricing({ detail, publication, config });
            const syncHash = crypto.createHash('sha256').update(JSON.stringify(synced.payload)).digest('hex');
            await db.saveWordPressPublication(detail.id, {
              translationId: publication.translation_id, externalId: publication.external_id,
              styleNo: publication.style_no, wpPostId: publication.wp_post_id,
              wpUrl: synced.wordpress.permalink || publication.wp_url,
              wpEditUrl: synced.wordpress.edit_link || publication.wp_edit_url,
              wpStatus: synced.wordpress.status || publication.wp_status,
              syncHash, payload: synced.payload, result: synced.wordpress, lastError: null,
            });
            job.wordpressUpdated += 1;
          } catch (error) {
            job.failed += 1;
            job.errors.push({ productDetailId: item.productDetailId, message: error.message });
          }
        }));
      }
      job.status = (job.failed || job.unresolved) ? 'completed_with_errors' : 'completed';
    } catch (error) {
      job.status = 'failed';
      job.failed += 1;
      job.errors.push({ message: error.message });
    } finally {
      job.completedAt = new Date().toISOString();
    }
  });
  return reply.code(202).send(job);
});

app.get('/api/wordpress-price-repair-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = wordpressPriceRepairJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
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

app.post('/api/product-details/:id/image-audit', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  try {
    const scheduled = await scheduleSavedProductAudits(detail.id, { trigger: 'manual', types: ['image'] });
    const completed = await scheduled.operation;
    if (completed.image?.error) throw new Error(completed.image.error);
    return { ...completed.image.result, persisted: true, auditRecordId: completed.image.record.id };
  } catch (error) {
    request.log.error({ err: error, productDetailId: detail.id }, 'gallery audit failed');
    return reply.code(502).send({ error: 'image_audit_failed', message: error.message });
  }
});

app.get('/api/product-details/:id/image-audits', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return db.listProductAudits('image', detail.id, request.query?.limit);
});

app.post('/api/product-details/:id/sku-audit', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  try {
    const scheduled = await scheduleSavedProductAudits(detail.id, { trigger: 'manual', types: ['sku'] });
    const completed = await scheduled.operation;
    if (completed.sku?.error) throw new Error(completed.sku.error);
    return { ...completed.sku.result, persisted: true, auditRecordId: completed.sku.record.id };
  } catch (error) {
    request.log.error({ err: error, productDetailId: detail.id }, 'saved SKU audit failed');
    return reply.code(502).send({ error: 'sku_audit_failed', message: error.message });
  }
});

app.get('/api/product-details/:id/sku-audits', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return db.listProductAudits('sku', detail.id, request.query?.limit);
});

app.post('/api/image-audit/test', { preHandler: requireApiKey }, async (request, reply) => {
  if (!Array.isArray(request.body?.images) || request.body.images.length < 1 || request.body.images.length > 30) {
    return reply.code(400).send({ error: 'images must contain 1 to 30 ordered persistent-storage image paths.' });
  }
  try {
    return await analyzeGalleryImages({ images: request.body.images, config: {
      apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
      visionModel: config.visionModel, complexModel: config.complexModel,
      storagePath: config.storagePath,
    } });
  } catch (error) {
    request.log.error({ err: error }, 'test gallery audit failed');
    return reply.code(502).send({ error: 'image_audit_test_failed', message: error.message });
  }
});

app.post('/api/image-audit/live', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
  const urls = Array.isArray(request.body?.urls) ? request.body.urls : [];
  if (!urls.length || urls.length > 5 || urls.some((url) => typeof url !== 'string'
    || !isAllowed1688Url(url) || !new URL(url).hostname.startsWith('detail.'))) {
    return reply.code(400).send({ error: 'urls must contain 1 to 5 HTTPS 1688 detail URLs.' });
  }
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', urls, createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, results: null, error: null };
  imageAuditJobs.set(id, job);
  while (imageAuditJobs.size > 100) imageAuditJobs.delete(imageAuditJobs.keys().next().value);
  multimodalAuditQueue = multimodalAuditQueue.catch(() => {}).then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const results = [];
    try {
      for (const url of urls) {
        try {
          const source = await collector.extractProductImagesInMemory(url);
          if (source.status !== 'completed') { results.push({ url, ...source }); continue; }
          const analysis = await analyzeGalleryImages({ images: source.images, config: {
            apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
            visionModel: config.visionModel, complexModel: config.complexModel,
            storagePath: config.storagePath,
          } });
          results.push({ url, offerId: source.offerId, title: source.title,
            imageCount: source.images.length, ...analysis });
        } catch (error) {
          results.push({ url, status: 'failed', error: error.message });
        }
      }
      job.results = results;
      job.status = results.every((item) => item.status === 'failed') ? 'failed' : 'completed';
      job.error = job.status === 'failed' ? 'All requested audits failed.' : null;
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
    } finally {
      job.completedAt = new Date().toISOString();
    }
  });
  return reply.code(202).send(job);
});

app.get('/api/image-audit/jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = imageAuditJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

app.post('/api/sku-audit/live', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
  const suppliedUrls = Array.isArray(request.body?.urls) ? request.body.urls : [];
  const offerIds = Array.isArray(request.body?.offerIds) ? request.body.offerIds : [];
  const urls = [...suppliedUrls, ...offerIds.map((offerId) => `https://detail.1688.com/offer/${offerId}.html`)];
  if (!urls.length || urls.length > 5 || urls.some((url) => typeof url !== 'string'
    || !isAllowed1688Url(url) || !new URL(url).hostname.startsWith('detail.'))
    || offerIds.some((offerId) => !/^\d{10,13}$/.test(String(offerId)))) {
    return reply.code(400).send({ error: 'Provide 1 to 5 valid 1688 detail URLs or numeric offerIds.' });
  }
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', urls, createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, results: null, error: null };
  skuAuditJobs.set(id, job);
  while (skuAuditJobs.size > 100) skuAuditJobs.delete(skuAuditJobs.keys().next().value);
  multimodalAuditQueue = multimodalAuditQueue.catch(() => {}).then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    const results = [];
    try {
      for (const url of urls) {
        try {
          const source = await collector.extractProductSkuAuditInput(url);
          if (source.status !== 'completed') { results.push({ url, ...source }); continue; }
          const audit = await auditProductSkus({
            product: source.product, skuImages: source.skuImages, galleryImages: source.galleryImages,
            config: { apiKey: config.dashscopeApiKey, baseUrl: config.dashscopeBaseUrl,
              visionModel: config.visionModel, complexModel: config.complexModel },
          });
          results.push({ url, offerId: source.offerId, title: source.title,
            skuImageCount: source.skuImages.length, galleryContextCount: source.galleryImages.length, ...audit });
        } catch (error) {
          results.push({ url, status: 'failed', error: error.message });
        }
      }
      job.results = results;
      job.status = results.every((item) => item.status === 'failed') ? 'failed' : 'completed';
      job.error = job.status === 'failed' ? 'All requested audits failed.' : null;
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
    } finally {
      job.completedAt = new Date().toISOString();
    }
  });
  return reply.code(202).send(job);
});

app.get('/api/sku-audit/jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = skuAuditJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

app.post('/api/plugin-session/check', { preHandler: [requireApiKey, requireCollectorMode] }, async (_request, reply) => {
  const job = await db.createJob(
    crypto.randomUUID(),
    'https://air.1688.com/',
    { mode: 'plugin_login' },
  );
  return reply.code(202).send(job);
});

app.post('/api/shop-contact-link', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
  const url = request.body?.url;
  if (typeof url !== 'string' || !isAllowed1688Url(url)) {
    return reply.code(400).send({ error: 'A valid HTTPS 1688 shop URL is required.' });
  }
  const job = await db.createJob(crypto.randomUUID(), url, { mode: 'shop_contact' });
  return reply.code(202).send(job);
});

app.post('/api/jobs', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
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

app.post('/api/shop-scans', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
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

app.post('/api/shop-scans/all', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
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
    if (!workerEnabled) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    workerActive = true;
    let job;
    try {
      job = await db.claimNextJob();
    } catch (error) {
      workerActive = false;
      throw error;
    }
    if (!job) {
      workerActive = false;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    try {
      const result = await collector.capture(job);
      if (result.extractedData?.pageType === 'shop') {
        await db.upsertShopProfile(result.extractedData);
      } else if (result.extractedData?.pageType === 'shop-offer-collection') {
        await db.saveShopScan(job.id, result.extractedData);
      } else if (job.options?.mode === 'product_detail'
          && result.extractedData?.pageType === 'product') {
        const duplicateAnalysis = await analyzeProductDuplicates({
          data: result.extractedData,
          imageFiles: result.extractedData.localImages ?? [],
          database: db,
          ragClient,
        });
        result.extractedData.duplicateAnalysis = duplicateAnalysis;
        if (duplicateAnalysis.decision === 'reject') {
          await cleanupRejectedProductImages(result.extractedData.localImages ?? []);
          result.extractedData.localImages = [];
          result.status = 'rejected_duplicate';
          result.error = null;
        } else {
          const saved = await db.saveProductDetail(
            result.extractedData, job.url, result.extractedData.localImages ?? [], duplicateAnalysis,
          );
          try {
            await scheduleSavedProductAudits(saved.productDetailId, { trigger: 'capture' });
          } catch (error) {
            app.log.error({ err: error, productDetailId: saved.productDetailId },
              'failed to schedule automatic product audits');
          }
          try {
            await scheduleProductRagSync(saved.productDetailId, { trigger: 'capture' });
          } catch (error) {
            app.log.error({ err: error, productDetailId: saved.productDetailId },
              'failed to schedule automatic products RAG sync');
          }
        }
      }
      await db.completeJob(job.id, result);
    } catch (error) {
      app.log.error({ err: error, jobId: job.id }, 'capture failed');
      await db.completeJob(job.id, {
        status: 'failed', title: null, finalUrl: null, domPath: null,
        screenshotPath: error.captureArtifacts?.screenshotPath ?? null,
        extractedData: null, error: error.message,
      });
    } finally {
      workerActive = false;
    }
    await new Promise((resolve) => setTimeout(resolve, config.minCaptureIntervalMs));
  }
}

async function shutdown() {
  workerRunning = false;
  workerEnabled = false;
  await waitForWorkerIdle();
  await loginManager.stop();
  await collector.stop();
  await db.pool.end();
  await app.close();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await db.migrate();
try {
  const hashBackfill = await db.backfillProductImageHashes();
  app.log.info(hashBackfill, 'product image hashes ready for duplicate detection');
} catch (error) {
  app.log.error({ err: error }, 'product image hash backfill failed; new captures will still be hashed');
}
await collector.start();
await app.listen({ port: config.port, host: '0.0.0.0' });
workerLoop().catch((error) => {
  app.log.fatal(error, 'worker stopped');
  process.exitCode = 1;
});
