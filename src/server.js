import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyHttpProxy from '@fastify/http-proxy';
import sharp from 'sharp';
import { createDatabase } from './db.js';
import { createCollector, is1688ShopUrl, isAllowed1688Url } from './collector.js';
import { analyzeProductImage } from './vision.js';
import { analyzeGalleryImages, auditProductGallery } from './image-cleaner.js';
import { auditProductSkus } from './sku-auditor.js';
import { translateProductDetail } from './product-translator.js';
import { prepareWordPressProductDraft, publishProductToWordPress,
  get1688ArrivalDate, setWordPressProductArrivalDate,
  setWordPressProductPublicationDate, setWordPressProductStatus,
  syncWordPressProductPricing, replaceWordPressBestSellers,
  resolveWordPressProduct, updateWordPressProductStyleNumber } from './wordpress-publisher.js';
import { localResolverLookup, parseProductResolverQuery } from './product-resolver.js';
import { createLoginManager } from './login-manager.js';
import { createConcurrentQueue } from './concurrent-queue.js';
import { buildRagProduct, createRagClient } from './rag-client.js';
import { analyzeProductDuplicates } from './duplicate-analyzer.js';
import { computeImageHashes } from './image-hash.js';
import { evaluateShopProductPolicy } from './shop-publication-policy.js';
import { selectBestSellers } from './best-seller-selector.js';
import { buildReviewQueue } from './review-queue.js';
import { classifyBundleSemantically, bundleClassifierConfig, failedBundleDetection } from './bundle-classifier.js';
import { analyzeBundleSplit, recomputePlan } from './bundle-splitter.js';
import { feishuConfigured, notifyBundleCapture, sendFeishuText } from './feishu.js';
import { buildSkuRowsFromSkuModel } from './sku-matrix.js';
import { buildLinkFoxCapture, downloadLinkFoxImages, fetchLinkFoxProductDetail,
  linkfoxExtrasForMerge } from './linkfox-1688.js';
import { MAX_OPTION_LABEL_LENGTH } from './option-overrides.js';

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
  modelApiKey: process.env.DEEPSEEK_API_KEY,
  modelBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  visionModel: process.env.DEEPSEEK_VISION_MODEL || 'deepseek-flash',
  complexModel: process.env.DEEPSEEK_COMPLEX_MODEL || 'deepseek-flash',
  reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || 'high',
  translationImageLimit: Math.min(Math.max(Number(process.env.TRANSLATION_IMAGE_LIMIT) || 6, 1), 8),
  translationConcurrency: Math.min(Math.max(Number(process.env.TRANSLATION_CONCURRENCY) || 1, 1), 10),
  savedAuditConcurrency: Math.min(Math.max(Number(process.env.SAVED_AUDIT_CONCURRENCY) || 3, 1), 5),
  savedAuditsStartPaused: process.env.SAVED_AUDITS_START_PAUSED === 'true',
  wordpressPublishConcurrency: Math.min(Math.max(Number(process.env.WORDPRESS_PUBLISH_CONCURRENCY) || 3, 1), 5),
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
  detailCaptureConcurrency: Math.min(Math.max(Number(process.env.DETAIL_CAPTURE_CONCURRENCY) || 1, 1), 5),
  portalApiUrl: process.env.PORTAL_API_URL?.trim() || '',
  portalAdminSecret: process.env.PORTAL_ADMIN_SECRET || '',
  linkfoxApiKey: process.env.LINKFOX_API_KEY?.trim() || process.env.LINKFOX_AGENT_API_KEY?.trim() || '',
  linkfoxGateway: process.env.LINKFOX_TOOL_GATEWAY?.trim() || 'https://tool-gateway.linkfox.com',
  feishuAppId: process.env.FEISHU_APP_ID?.trim() || '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET?.trim() || '',
  feishuChatId: process.env.FEISHU_CHAT_ID?.trim() || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || 'https://collector.yiswim.cloud',
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
let workerActiveCount = 0;
let browserMode = 'collector';
let browserTransition = null;
let modeSwitchQueue = Promise.resolve();
const skuAuditJobs = new Map();
const imageAuditJobs = new Map();
const detailImageJobs = new Map();
const translationJobs = new Map();
const wordpressJobs = new Map();
const wordpressPublicationDateJobs = new Map();
const wordpressArrivalDateJobs = new Map();
const wordpressPriceRepairJobs = new Map();
const wordpressBestSellerJobs = new Map();
let multimodalAuditQueue = Promise.resolve();
const savedAuditQueue = createConcurrentQueue({
  concurrency: config.savedAuditConcurrency,
  onTaskError: (error) => app.log.error({ err: error }, 'unhandled saved audit queue error'),
});
const translationQueue = createConcurrentQueue({
  concurrency: config.translationConcurrency,
  onTaskError: (error) => app.log.error({ err: error }, 'unhandled translation queue error'),
});
const ragSyncQueue = createConcurrentQueue({
  concurrency: config.productsRagSyncConcurrency,
  onTaskError: (error) => app.log.error({ err: error }, 'unhandled products RAG sync error'),
});
const wordpressPublishQueue = createConcurrentQueue({
  concurrency: config.wordpressPublishConcurrency,
  onTaskError: (error) => app.log.error({ err: error }, 'unhandled WordPress publish queue error'),
});
let wordpressMaintenanceQueue = Promise.resolve();

async function buildBestSellerPlan(limit = 36) {
  const candidates = await db.listBestSellerCandidates();
  return selectBestSellers(candidates, Math.min(Math.max(Number(limit) || 36, 1), 48));
}

function trimTerminalJobs(jobMap, maxEntries = 2000) {
  if (jobMap.size <= maxEntries) return;
  for (const [id, job] of jobMap) {
    if (!['queued', 'running'].includes(job?.status)) jobMap.delete(id);
    if (jobMap.size <= maxEntries) break;
  }
}

function isExternalModelAccessError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('failed (401)') || message.includes('failed (402)')
    || message.includes('failed (403)') || message.includes('accessdenied')
    || message.includes('arrearage') || message.includes('unpurchased')
    || message.includes('insufficient balance') || message.includes('insufficient_balance')
    || message.includes('deepseek_api_key is not configured');
}

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

// Dashboard pages authenticate with HTTP Basic; maintenance scripts use the
// collector Bearer key. Both are accepted for the products page API.
function requireDashboardOrApiKey(request, reply, done) {
  const header = request.headers.authorization || '';
  if (/^Bearer\s+/i.test(header)) return requireApiKey(request, reply, done);
  return requireDashboardAuth(request, reply, done);
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

function requireDashboardAuth(request, reply, done) {
  if (!config.novncUsername || !config.novncPassword) {
    reply.code(503).send({ error: 'dashboard_credentials_not_configured' });
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
    reply.header('WWW-Authenticate', 'Basic realm="1688 Collector Dashboard"');
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  done();
}

async function waitForWorkerIdle() {
  while (workerActiveCount > 0) await new Promise((resolve) => setTimeout(resolve, 100));
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
    workerActive: workerActiveCount > 0,
    workerActiveCount,
    detailCaptureConcurrency: config.detailCaptureConcurrency,
    collector: collector.getSessionStatus(),
    login: loginManager.getStatus(),
    loginUrl: `https://${process.env.LOGIN_PUBLIC_HOST || 'collector.yiswim.cloud'}/login/vnc.html?autoconnect=1&resize=remote&path=login/websockify`,
  };
}

function auditModelConfig() {
  return {
    apiKey: config.modelApiKey,
    baseUrl: config.modelBaseUrl,
    visionModel: config.visionModel,
    complexModel: config.complexModel,
    reasoningEffort: config.reasoningEffort,
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
  const operations = Object.entries(records).map(([auditType, record]) => new Promise((resolve) => {
    savedAuditQueue.enqueue(async () => {
      try {
        const result = await executeSavedProductAudits(productDetailId, { [auditType]: record });
        if (isExternalModelAccessError(result?.[auditType]?.error)) savedAuditQueue.pause();
        resolve(result);
      } catch (error) {
        app.log.error({ err: error, productDetailId, auditType }, 'saved product audit failed');
        await db.failProductAudit(auditType, record.id, error).catch(() => {});
        resolve({ [auditType]: { error: error.message } });
      }
    });
  }));
  const operation = Promise.all(operations).then((parts) => Object.assign({}, ...parts));
  return { records, operation };
}

async function recoverSavedProductAudits() {
  const pending = await db.recoverPendingProductAudits();
  for (const record of pending) {
    savedAuditQueue.enqueue(async () => {
      try {
        const result = await executeSavedProductAudits(record.product_detail_id,
          { [record.audit_type]: record });
        if (isExternalModelAccessError(result?.[record.audit_type]?.error)) {
          savedAuditQueue.pause();
          app.log.warn({ auditRecordId: record.id },
            'saved audit queue paused because model access is unavailable');
        }
      } catch (error) {
        app.log.error({ err: error, productDetailId: record.product_detail_id,
          auditType: record.audit_type, auditRecordId: record.id }, 'recovered product audit failed');
        await db.failProductAudit(record.audit_type, record.id, error).catch(() => {});
      }
    });
  }
  return pending.length;
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
  dashboard: '/dashboard',
  review: '/review',
  bundleCheck: '/bundle-check',
  shops: '/shops',
  browserMode: getBrowserModeStatus(),
  session: collector.getSessionStatus(),
}));

app.get('/dashboard', { preHandler: requireDashboardAuth }, async (_request, reply) => {
  const html = await fs.readFile(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/shops', { preHandler: requireDashboardAuth }, async (_request, reply) => {
  const html = await fs.readFile(new URL('../public/shops.html', import.meta.url), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/api/shops-overview', { preHandler: requireDashboardAuth }, async () => {
  const [shops, unassigned] = await Promise.all([
    db.listShopsOverview(), db.listUnassignedOverview(),
  ]);
  return { generatedAt: new Date().toISOString(), shops, unassigned };
});

app.get('/api/shops-overview/products', { preHandler: requireDashboardAuth }, async (request, reply) => {
  const query = request.query ?? {};
  const unassigned = query.unassigned === 'true' || query.unassigned === '1';
  const shopId = Number(query.shopId);
  if (!unassigned && !Number.isInteger(shopId)) {
    return reply.code(400).send({ error: 'shop_id_required' });
  }
  const status = ['all', 'published', 'draft', 'captured', 'not_captured'].includes(query.status)
    ? query.status : 'all';
  const stylePrefixRaw = String(query.stylePrefix ?? '').trim().toUpperCase();
  const options = {
    shopId: unassigned ? null : shopId,
    unassigned,
    status,
    search: String(query.search ?? '').trim().slice(0, 120),
    availability: ['all', 'active', 'delisted'].includes(query.availability) ? query.availability : 'all',
    eligible: ['all', 'true', 'false'].includes(query.eligible) ? query.eligible : 'all',
    gallery: ['all', 'complete', 'incomplete'].includes(query.gallery) ? query.gallery : 'all',
    stylePrefix: /^[A-Z]{2,6}$/.test(stylePrefixRaw) ? stylePrefixRaw : '',
    sort: String(query.sort ?? '').trim().slice(0, 32) || 'listing_desc',
    limit: Math.min(Math.max(Number(query.limit) || 50, 1), 200),
    offset: Math.max(Number(query.offset) || 0, 0),
  };
  const [items, total] = await Promise.all([
    db.listShopOverviewProducts(options), db.countShopOverviewProducts(options),
  ]);
  return { total, limit: options.limit, offset: options.offset, items };
});

async function importWordPressProductToPortal(identifier) {
  const response = await fetch(new URL('/api/v1/admin/catalog/import/wordpress', config.portalApiUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.portalAdminSecret}`,
    },
    body: JSON.stringify({ identifiers: [identifier] }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? body?.error ?? `Portal returned HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return Array.isArray(body?.products) ? body.products[0] ?? null : null;
}

function sizeCountFromSkuDimensions(skuDimensions) {
  const dims = Array.isArray(skuDimensions) ? skuDimensions : [];
  const dim = dims.find((entry) => /(尺码|尺寸|码数|size)/i.test(String(entry?.name || '')));
  if (!dim) return 0;
  return [...new Set((Array.isArray(dim.values) ? dim.values : [])
    .map((value) => String(value).trim())
    .filter((value) => value && !/(均码|one\s*size|free\s*size)/i.test(value)))].length;
}

app.post('/api/portal/publish', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const productDetailId = Number(request.body?.productDetailId);
  if (!Number.isInteger(productDetailId) || productDetailId <= 0) {
    return reply.code(400).send({ error: 'product_detail_id_required' });
  }
  if (!config.portalApiUrl || !config.portalAdminSecret) {
    return reply.code(503).send({ error: 'portal_not_configured' });
  }
  const detail = await db.getProductDetail(productDetailId);
  if (!detail) return reply.code(404).send({ error: 'product_not_found' });
  const publication = await db.getWordPressPublication(productDetailId);
  if (!publication?.wp_post_id && !publication?.style_no) {
    return reply.code(409).send({ error: 'wordpress_publication_required' });
  }
  const identifier = String(publication.wp_post_id ?? publication.style_no);
  try {
    const product = await importWordPressProductToPortal(identifier);
    const portalBase = config.portalApiUrl.replace(/\/$/, '');
    const saved = await db.savePortalPublication(productDetailId, {
      wpPostId: publication.wp_post_id ?? null,
      styleNo: publication.style_no ?? product?.styleNumber ?? null,
      portalProductId: product?.id ?? null,
      portalStatus: product?.status ?? null,
      sourceKey: publication.wp_post_id ? `wordpress:${publication.wp_post_id}` : null,
      portalUrl: product?.id ? `${portalBase}/admin/catalog` : null,
      result: product ? {
        id: product.id, status: product.status, title: product.title,
        styleNumber: product.styleNumber, variantCount: (product.variants ?? []).length,
        mediaCount: (product.media ?? []).length,
      } : {},
      lastError: null,
    });
    return { status: 'synced', productDetailId, portalProduct: product, publication: saved };
  } catch (error) {
    const message = String(error?.message || error);
    await db.failPortalPublication(productDetailId, message, {
      wpPostId: publication.wp_post_id ?? null,
      styleNo: publication.style_no ?? null,
    }).catch(() => {});
    return reply.code(502).send({ error: 'portal_publish_failed', message });
  }
});

// Batch portal catalog sync: eligible = products of one shop listed in the
// given year, not flagged as bundles, with at least `minSizes` real sizes
// (均码 excluded) and a live wearhongxiu publication. Already-synced items are
// skipped unless `refresh:true`. `dryRun:true` only reports counts.
app.post('/api/portal/publish-batch', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  if (!config.portalApiUrl || !config.portalAdminSecret) {
    return reply.code(503).send({ error: 'portal_not_configured' });
  }
  const shopId = Number(request.body?.shopId);
  if (!Number.isInteger(shopId) || shopId <= 0) return reply.code(400).send({ error: 'shop_id_required' });
  const year = Number(request.body?.year) || new Date().getUTCFullYear();
  const minSizes = Number(request.body?.minSizes) > 0 ? Number(request.body.minSizes) : 3;
  const limit = Math.min(Math.max(Number(request.body?.limit) || 50, 1), 200);
  const offset = Math.max(Number(request.body?.offset) || 0, 0);
  const refresh = request.body?.refresh === true;
  const dryRun = request.body?.dryRun === true;
  const rows = await db.listPortalPublishCandidates({
    shopId, since: `${year}-01-01T00:00:00.000Z`, until: `${year + 1}-01-01T00:00:00.000Z`, limit: 500,
  });
  const evaluated = rows.map((row) => ({ row, sizeCount: sizeCountFromSkuDimensions(row.sku_dimensions) }));
  const eligible = evaluated.filter(({ row, sizeCount }) =>
    sizeCount >= minSizes && row.wp_status === 'publish' && row.wp_post_id != null);
  const pending = eligible.filter(({ row }) => refresh || !row.portal_product_id);
  const notEligible = rows.length - eligible.length;
  const alreadyPublished = eligible.length - pending.length;
  if (dryRun) {
    return {
      dryRun: true, shopId, year, minSizes,
      candidates: rows.length, eligible: eligible.length, alreadyPublished,
      notEligible, pending: pending.length,
      pendingItems: pending.map(({ row, sizeCount }) => ({
        detailId: row.product_detail_id, styleNo: row.style_no, offerId: row.offer_id, sizeCount,
        availability: row.availability_status, wpStatus: row.wp_status, wpUrl: row.wp_url,
      })),
      sample: pending.slice(0, 25).map(({ row, sizeCount }) => ({
        detailId: row.product_detail_id, styleNo: row.style_no, sizeCount,
        availability: row.availability_status, wpStatus: row.wp_status, portalStatus: row.portal_status,
      })),
    };
  }
  const batch = pending.slice(offset, offset + limit);
  const results = [];
  let published = 0; let failed = 0; let skippedDelisted = 0;
  const queue = [...batch];
  async function worker() {
    while (queue.length) {
      const { row } = queue.shift();
      const base = { detailId: row.product_detail_id, styleNo: row.style_no, offerId: row.offer_id };
      if (row.availability_status && row.availability_status !== 'active') {
        skippedDelisted += 1;
        results.push({ ...base, status: 'skipped_delisted' });
        continue;
      }
      try {
        const product = await importWordPressProductToPortal(String(row.wp_post_id ?? row.style_no));
        const portalBase = config.portalApiUrl.replace(/\/$/, '');
        const saved = await db.savePortalPublication(row.product_detail_id, {
          wpPostId: row.wp_post_id ?? null,
          styleNo: row.style_no ?? product?.styleNumber ?? null,
          portalProductId: product?.id ?? null,
          portalStatus: product?.status ?? null,
          sourceKey: row.wp_post_id ? `wordpress:${row.wp_post_id}` : null,
          portalUrl: product?.id ? `${portalBase}/admin/catalog` : null,
          result: product ? {
            id: product.id, status: product.status, title: product.title,
            styleNumber: product.styleNumber, variantCount: (product.variants ?? []).length,
            mediaCount: (product.media ?? []).length,
          } : {},
          lastError: null,
        });
        published += 1;
        results.push({ ...base, status: 'published', portalProductId: saved.portal_product_id, portalStatus: saved.portal_status });
      } catch (error) {
        const message = String(error?.message || error);
        failed += 1;
        await db.failPortalPublication(row.product_detail_id, message, {
          wpPostId: row.wp_post_id ?? null, styleNo: row.style_no ?? null,
        }).catch(() => {});
        results.push({ ...base, status: 'failed', error: message });
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return {
    processed: batch.length, published, failed, skippedDelisted,
    remaining: Math.max(pending.length - offset - batch.length, 0),
    eligible: eligible.length, alreadyPublished,
    results,
  };
});

// Re-run bundle classification for products currently flagged as bundles (e.g.
// after a classifier policy change). Only clears flags; never adds new ones.
// The keyword rules were removed; the model verdict is authoritative.

// Full bundle re-evaluation over every capture, judged semantically by the
// model from the variant option texts. Runs as a background job because the
// model calls take minutes; manual overrides are preserved untouched.
// Poll with GET /api/bundle-audit/jobs/{id}.
const bundleRecheckJobs = new Map();

async function runBundleRecheckJob(job, { limit, concurrency = 6, ids = null }) {
  const batchSize = 200;
  let offset = 0;
  let remaining = limit;
  while (remaining > 0) {
    const take = Math.min(batchSize, remaining);
    const rows = await db.listBundleRecheckRows({ limit: take, offset });
    if (!rows.length) break;
    const selected = ids ? rows.filter((row) => ids.includes(Number(row.id))) : rows;
    let next = 0;
    const workers = Array.from({ length: Math.max(Math.min(concurrency, selected.length), 1) }, async () => {
      while (true) {
        const index = next++;
        if (index >= selected.length) return;
        const row = selected[index];
        job.scanned += 1;
        if (row.bundle_manual_status) { job.manualSkipped += 1; continue; }
        const data = {
          skuOptions: row.sku_options ?? [],
          skuDimensions: row.sku_dimensions ?? [],
          skuMatrix: row.sku_matrix ?? null,
        };
        let detection = null;
        for (let attempt = 1; attempt <= 2 && !detection; attempt += 1) {
          try {
            detection = await classifyBundleSemantically({
              data, title: row.title, config: bundleClassifierConfig(config),
            });
          } catch (error) {
            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 2500));
              continue;
            }
            // No previous verdict is overwritten on failure: keep whatever the
            // row already had and report the row for a later retry.
            job.modelErrors += 1;
            if (job.fallbackIds.length < 500) job.fallbackIds.push(row.id);
          }
        }
        if (!detection) continue;
        if (detection.status === 'bundle') job.bundles += 1; else job.clear += 1;
        const previous = row.bundle_status ?? 'clear';
        if (previous !== detection.status) {
          job.changed += 1;
          if (detection.status === 'bundle') job.clearToBundle += 1;
          else job.bundleToClear += 1;
          if (job.samples.length < 60) {
            job.samples.push({
              id: row.id, offerId: row.offer_id, title: row.title,
              from: previous, to: detection.status, reason: detection.analysis?.reason ?? null,
            });
          }
        }
        await db.saveProductBundleStatus(row.id, detection);
      }
    });
    await Promise.all(workers);
    offset += rows.length;
    remaining -= rows.length;
    if (rows.length < take) break;
  }
  job.status = job.modelErrors ? 'completed_with_errors' : 'completed';
  job.completedAt = new Date().toISOString();
}

app.post('/api/bundle-audit/recheck-all', { preHandler: requireApiKey }, async (request, reply) => {
  if ([...bundleRecheckJobs.values()].some((entry) => entry.status === 'running')) {
    return reply.code(409).send({ error: 'recheck_already_running' });
  }
  const mode = 'llm';
  const limit = Number(request.body?.limit) > 0 ? Math.min(Number(request.body.limit), 5000) : 5000;
  const ids = Array.isArray(request.body?.ids)
    ? request.body.ids.map(Number).filter((value) => Number.isInteger(value) && value > 0).slice(0, 500)
    : null;
  const id = crypto.randomUUID();
  const job = {
    id, mode, status: 'running', scanned: 0, bundles: 0, clear: 0, changed: 0,
    bundleToClear: 0, clearToBundle: 0, manualSkipped: 0, modelErrors: 0, fallbackIds: [],
    samples: [], createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null,
  };
  bundleRecheckJobs.set(id, job);
  trimTerminalJobs(bundleRecheckJobs);
  runBundleRecheckJob(job, { limit, ids }).catch((error) => {
    job.status = 'failed';
    job.error = String(error.message || error);
    app.log.error({ err: error, jobId: id }, 'bundle recheck job failed');
  });
  return reply.code(202).send({ id, status: 'running', mode, limit, ids });
});

app.get('/api/bundle-audit/jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = bundleRecheckJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// Send one test message to the configured Feishu group (bundle notifications
// use the same channel and credentials).
app.post('/api/feishu/test', { preHandler: requireApiKey }, async (request, reply) => {
  if (!feishuConfigured(config)) {
    return reply.code(503).send({ error: 'feishu_not_configured' });
  }
  try {
    const result = await sendFeishuText({
      text: `✅ 采集器飞书通知连通性测试（bundle 判定通知将发送到此群）\n${new Date().toISOString()}`,
      config,
    });
    return { ok: true, messageId: result.messageId };
  } catch (error) {
    return reply.code(502).send({ error: 'feishu_send_failed', message: String(error?.message || error).slice(0, 300) });
  }
});

// Manual bundle verdict for one capture: {status: 'bundle' | 'clear' | 'auto'}.
// Stored in bundle_manual_status, so it survives re-captures and re-runs;
// 'auto' clears the override and re-judges the capture right away.
app.post('/api/product-details/:id/bundle-status', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const requested = String(request.body?.status ?? '').trim();
  if (!['bundle', 'clear', 'auto'].includes(requested)) {
    return reply.code(400).send({ error: 'invalid_status', message: 'status must be bundle, clear or auto' });
  }
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  if (requested === 'auto') {
    // Classify first: a model failure must not clear the manual override.
    let detection;
    try {
      detection = await classifyBundleSemantically({
        data: {
          skuOptions: detail.raw_data?.skuOptions ?? [],
          skuDimensions: detail.raw_data?.skuDimensions ?? [],
          skuMatrix: detail.raw_data?.skuMatrix ?? null,
        },
        title: detail.title, config: bundleClassifierConfig(config),
      });
    } catch (error) {
      return reply.code(502).send({
        error: 'bundle_classification_failed',
        message: String(error?.message || error).slice(0, 300),
      });
    }
    await db.setProductBundleManual(id, null);
    const saved = await db.saveProductBundleStatus(id, detection);
    return {
      productDetailId: id, status: saved?.bundle_status ?? detection.status,
      manual: null, detector: detection.status, reason: detection.analysis?.reason ?? null,
    };
  }
  const saved = await db.setProductBundleManual(id, requested);
  return {
    productDetailId: id, status: saved?.bundle_status ?? requested,
    manual: saved?.bundle_manual_status ?? requested, manualAt: saved?.bundle_manual_at ?? null,
  };
});

// LLM split analysis for a bundle capture: groups the option texts into the
// products actually sold in the listing (ignoring seller chatter), assigns the
// gallery images to them, and derives sizes/prices from the stored SKU matrix.
app.post('/api/product-details/:id/split-analysis', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  try {
    const { plan } = await analyzeBundleSplit({
      detail,
      config: {
        apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
        model: config.complexModel, reasoningEffort: config.reasoningEffort,
      },
      baseUrl: config.publicBaseUrl,
    });
    const saved = await db.saveProductSplitPlan(id, plan);
    return { productDetailId: id, plan: saved.plan, updatedAt: saved.updated_at };
  } catch (error) {
    request.log.error({ err: error, productDetailId: id }, 'bundle split analysis failed');
    return reply.code(502).send({
      error: 'split_analysis_failed', message: String(error?.message || error).slice(0, 300),
    });
  }
});

app.get('/api/product-details/:id/split-plan', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const record = await db.getProductSplitPlan(id);
  return { productDetailId: id, plan: record?.plan ?? null, updatedAt: record?.updated_at ?? null };
});

// Save a manually adjusted split plan. Sizes and prices are always recomputed
// from the stored SKU matrix, never trusted from the client.
app.put('/api/product-details/:id/split-plan', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const plan = recomputePlan(request.body?.plan ?? {}, detail);
  if (!plan.products.length) return reply.code(400).send({ error: 'empty_plan' });
  const saved = await db.saveProductSplitPlan(id, plan);
  return { productDetailId: id, plan: saved.plan, updatedAt: saved.updated_at };
});

app.get('/api/dashboard/stats', { preHandler: requireDashboardAuth }, async () => ({
  ...(await db.getDashboardStats()),
  runtime: {
    browserMode: getBrowserModeStatus(),
    session: collector.getSessionStatus(),
    queues: {
      savedAudits: savedAuditQueue.stats(),
      translations: translationQueue.stats(),
      ragSync: ragSyncQueue.stats(),
      wordpressPublish: wordpressPublishQueue.stats(),
    },
  },
}));

// Read-only review queue. Same HTTP Basic gate as /dashboard: the page is served
// by this app, so the browser replays the credentials on the same-origin fetch.
app.get('/review', { preHandler: requireDashboardAuth }, async (_request, reply) => {
  const html = await fs.readFile(new URL('../public/review.html', import.meta.url), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

// Read-only variant/bundle check for a shop's 2026 published products. Shows
// the captured original variant names and images plus the bundle verdict.
// Same HTTP Basic gate as /review.
app.get('/bundle-check', { preHandler: requireDashboardAuth }, async (_request, reply) => {
  const html = await fs.readFile(new URL('../public/bundle-check.html', import.meta.url), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

// All captured products, read-only: names, variant options (with swatch
// images), gallery thumbnails, price range and WordPress state.
app.get('/products', { preHandler: requireDashboardAuth }, async (_request, reply) => {
  const html = await fs.readFile(new URL('../public/products.html', import.meta.url), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/api/review/queue', { preHandler: requireDashboardAuth }, async (request, reply) => {
  try {
    const days = request.query?.days;
    const limit = request.query?.limit;
    const shopId = request.query?.shopId ?? null;
    const rows = await db.listReviewQueue({ limit, days, shopId });
    const window = {
      days: Number(days) || 30,
      limit: Number(limit) || 300,
      shopId: shopId === null || shopId === '' ? null : Number(shopId),
    };
    return {
      generatedAt: new Date().toISOString(),
      window,
      scanned: rows.length,
      truncated: rows.length >= window.limit,
      ...buildReviewQueue(rows),
    };
  } catch (error) {
    request.log.error({ err: error }, 'failed to build review queue');
    return reply.code(500).send({ error: 'review_queue_failed', message: error.message });
  }
});

// Product images for the review page. Alibaba's CDN answers 403 when the
// Referer is not a 1688 page, so embedding the original URLs directly breaks in
// the browser. Serving the copy the audit actually analysed keeps the page
// same-origin; the CDN URL stays as a fallback for captures without a local file.
app.get('/api/review/image/:id', { preHandler: requireDashboardAuth }, async (request, reply) => {
  const id = Number(request.params?.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_image_id' });
  let image;
  try {
    image = await db.getProductImage(id);
  } catch (error) {
    request.log.error({ err: error }, 'failed to load product image');
    return reply.code(500).send({ error: 'image_lookup_failed' });
  }
  if (!image) return reply.code(404).send({ error: 'image_not_found' });

  if (image.storage_path) {
    const resolved = path.resolve(String(image.storage_path));
    const root = path.resolve(config.storagePath);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      try {
        const data = await fs.readFile(resolved);
        return reply.type(image.mime_type || 'image/webp')
          .header('Cache-Control', 'private, max-age=86400')
          .send(data);
      } catch (error) {
        request.log.warn({ err: error, imageId: id }, 'local product image unreadable, falling back to source URL');
      }
    } else {
      request.log.warn({ imageId: id, storagePath: image.storage_path }, 'refusing image outside the storage root');
    }
  }

  if (!image.source_url) return reply.code(404).send({ error: 'image_unavailable' });
  return reply.code(302).header('Location', String(image.source_url)).send();
});

app.get('/health', async (_request, reply) => {
  try {
    await db.ping();
    return { ok: true, queues: { savedAudits: savedAuditQueue.stats(),
      wordpressPublish: wordpressPublishQueue.stats() } };
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

app.post('/api/browser-mode/logout-login', { preHandler: requireApiKey }, async (request, reply) => {
  try {
    await switchBrowserMode('login');
    const logout = await loginManager.logoutAndOpenSignin();
    return { ...getBrowserModeStatus(), logout };
  } catch (error) {
    request.log.error({ err: error }, 'failed to log out and reopen the login page');
    return reply.code(500).send({ error: 'logout_login_failed', message: error.message });
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
  const resolvedOfferId = typeof offerId === 'string' && /^\d{10,13}$/.test(offerId)
    ? offerId : url.match(/\/offer\/(\d{10,13})\.html/i)?.[1];
  if (resolvedOfferId) {
    const sourceListings = await db.listShopProductSources(resolvedOfferId);
    const policy = evaluateShopProductPolicy(sourceListings);
    if (!policy.allowed) {
      return reply.code(422).send({
        error: 'shop_product_policy_rejected', policy: policy.policy, reason: policy.reason,
      });
    }
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

// LinkFox source branch: no browser involved, so it stays available while the
// collector runs in login mode (1688 risk control, captcha solves, etc.).
//
// captureAs=new    -> save an independent "lfx-{offerId}" capture with every
//                     LinkFox media image (main/gallery/swatch/description) and
//                     all LinkFox-only fields; the 1688 browser duplicate gates
//                     are intentionally not applied.
// captureAs=merge  -> merge only the LinkFox enrichment fields (raw linkfox
//                     payload, package data, seller metrics) into the existing
//                     browser capture of the same offer.
app.post('/api/product-details/linkfox', { preHandler: requireApiKey }, async (request, reply) => {
  const body = request.body ?? {};
  const offerId = String(body.offerId ?? '').trim()
    || String(body.url ?? '').match(/\/offer\/(\d{10,13})\.html/i)?.[1] || '';
  if (!/^\d{10,13}$/.test(offerId)) {
    return reply.code(400).send({ error: 'valid_1688_offer_id_required' });
  }
  if (!config.linkfoxApiKey) {
    return reply.code(503).send({ error: 'linkfox_not_configured' });
  }
  const captureMode = ['merge', 'primary'].includes(String(body.captureAs)) ? String(body.captureAs) : 'new';
  const existingDetail = (await db.listProductDetails({ offerId, limit: 1 }))[0] ?? null;
  if (captureMode === 'merge' && !existingDetail) {
    return reply.code(404).send({ error: 'existing_detail_required_for_merge' });
  }
  // primary: first-class capture under the real offer id — create it when the
  // offer has no capture yet, otherwise refresh the existing one (merge).
  const primaryMerge = captureMode === 'primary' && Boolean(existingDetail);
  const primaryCreate = captureMode === 'primary' && !existingDetail;
  let raw;
  try {
    raw = await fetchLinkFoxProductDetail({ offerId }, config);
  } catch (error) {
    request.log.error({ err: error, offerId }, 'LinkFox product detail fetch failed');
    return reply.code(502).send({
      error: error.providerAccess ? 'linkfox_access_blocked' : 'linkfox_fetch_failed',
      message: error.message,
    });
  }

  if (captureMode === 'merge' || primaryMerge) {
    const existing = existingDetail;
    const updateSkus = primaryMerge ? body.updateSkus !== false : body.updateSkus === true;
    const extras = linkfoxExtrasForMerge(raw);
    const updated = await db.updateProductLinkFoxData(existing.id, extras);
    let skus = null;
    if (updateSkus) {
      // Variant backfill: rewrite the stored colour x size rows (price/stock/
      // skuId), the option dimensions and the matrix from the LinkFox skuList,
      // then re-run the deterministic bundle detector on the fresh data.
      const capture = buildLinkFoxCapture(raw, { offerId, offerKey: offerId });
      if (!capture.data.skuRows.length) {
        return reply.code(422).send({ error: 'linkfox_no_sku_rows', merged: true });
      }
      const dimensions = capture.data.skuDimensions;
      const skuMatrix = capture.data.skuMatrix;
      // Only a verified positive LinkFox range may touch the stored price
      // columns; Number(null) must never collapse to 0 here.
      const linkfoxPrice = capture.data.price ?? {};
      const priceMin = linkfoxPrice.verified === true && Number(linkfoxPrice.min) > 0
        ? Number(linkfoxPrice.min) : null;
      const priceMax = linkfoxPrice.verified === true && Number(linkfoxPrice.max) > 0
        ? Number(linkfoxPrice.max) : null;
      // LinkFox sometimes publishes only tier prices; keep any per-SKU price
      // the previous rows already had so the variant table does not lose it.
      // Old browser rows may carry size-only keys with the colour in
      // option_data, so match on the normalized (colour, size) pair first and
      // fall back to an unambiguous size-only match.
      const fresh = await db.getProductDetail(existing.id);
      const normalizeValue = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
      const colorSizeOf = (row) => {
        const options = row.options ?? row.option_data ?? {};
        const key = String(row.skuKey ?? row.sku_key ?? '');
        const fromKey = new Map();
        for (const part of key.split('|')) {
          const index = part.indexOf(':');
          if (index < 0) continue;
          const name = part.slice(0, index).trim();
          const value = part.slice(index + 1).trim();
          const canonical = /^(?:颜色|color)$/i.test(name) ? 'Color'
            : /^(?:尺码|尺寸|码数|size)$/i.test(name) ? 'Size' : name;
          fromKey.set(canonical, value);
        }
        return {
          color: normalizeValue(fromKey.get('Color') ?? options.Color ?? options['颜色'] ?? ''),
          size: normalizeValue(fromKey.get('Size') ?? options.Size ?? options['尺码'] ?? ''),
        };
      };
      const priorByPair = new Map();
      const priorBySize = new Map();
      for (const row of fresh?.skus ?? []) {
        const value = Number(row.price);
        if (!(Number.isFinite(value) && value > 0)) continue;
        const { color, size } = colorSizeOf(row);
        if (color && size) priorByPair.set(`${color}\u0001${size}`, value);
        if (size) {
          const entry = priorBySize.get(size) ?? { values: new Set() };
          entry.values.add(value);
          priorBySize.set(size, entry);
        }
      }
      let pricesPreserved = 0;
      for (const row of capture.data.skuRows) {
        if (row.price !== null && row.price !== undefined) continue;
        const { color, size } = colorSizeOf(row);
        let prior = color && size ? priorByPair.get(`${color}\u0001${size}`) : undefined;
        if (prior === undefined && size) {
          const entry = priorBySize.get(size);
          if (entry && entry.values.size === 1) prior = [...entry.values][0];
        }
        if (prior !== undefined) {
          row.price = prior;
          pricesPreserved += 1;
        }
      }
      await db.updateProductSkusFromMatrix(existing.id, {
        rows: capture.data.skuRows, dimensions, skuMatrix, priceMin, priceMax,
        skuOptions: capture.data.skuOptions, source: 'linkfox',
      });
      let bundleOutcome = null;
      try {
        const detection = await classifyBundleSemantically({
          data: {
            skuOptions: capture.data.skuOptions, skuDimensions: dimensions, skuMatrix,
          },
          title: existing.title, config: bundleClassifierConfig(config),
        });
        await db.saveProductBundleStatus(existing.id, detection);
        bundleOutcome = { status: detection.status, reason: detection.analysis?.reason ?? null };
      } catch (error) {
        // Keep the previous verdict when the model is unavailable.
        bundleOutcome = { status: null, error: String(error?.message || error).slice(0, 200) };
      }
      skus = {
        rows: capture.data.skuRows.length, dimensions: dimensions.map((dimension) => dimension.name),
        priceMin, priceMax, bundle: bundleOutcome.status, bundleError: bundleOutcome.error ?? undefined,
        pricesPreserved,
      };
    }
    return {
      mode: primaryMerge ? 'primary_merged' : 'merge',
      productDetailId: existing.id,
      ...(primaryMerge ? { offerKey: String(offerId) } : {}),
      fields: Object.keys(extras), updated, skus,
    };
  }

  const offerKey = primaryCreate ? String(offerId) : `lfx-${offerId}`;
  const capture = buildLinkFoxCapture(raw, { offerId, offerKey });
  let imageFiles;
  try {
    imageFiles = await downloadLinkFoxImages(capture.imagePlan, {
      storagePath: config.storagePath, offerKey,
    });
  } catch (error) {
    request.log.error({ err: error, offerId }, 'LinkFox image download failed');
    return reply.code(500).send({ error: 'linkfox_image_download_failed', message: error.message });
  }
  if (!imageFiles.length) return reply.code(502).send({ error: 'linkfox_images_unavailable' });
  const imageTypes = {};
  for (const image of imageFiles) imageTypes[image.type] = (imageTypes[image.type] ?? 0) + 1;

  const data = { ...capture.data, localImages: imageFiles };
  let duplicateAnalysis;
  if (primaryCreate) {
    // A first-class capture keeps the normal duplicate protection: exact
    // gallery bytes and the main-image perceptual hash both run here.
    duplicateAnalysis = await analyzeProductDuplicates({
      data, imageFiles, database: db, ragClient,
    });
    if (duplicateAnalysis.decision === 'reject') {
      await cleanupRejectedProductImages(imageFiles);
      return reply.code(409).send({ error: 'rejected_duplicate', duplicateAnalysis });
    }
  } else {
    let mainImageHash = null;
    const mainImage = imageFiles.find((image) => image.type === 'main');
    if (mainImage?.storagePath) {
      try {
        mainImageHash = await computeImageHashes(await fs.readFile(mainImage.storagePath));
      } catch (error) {
        request.log.warn({ err: error }, 'failed to hash the LinkFox main image');
      }
    }
    duplicateAnalysis = {
      status: 'linkfox_branch_capture',
      decision: 'accept',
      checkedAt: new Date().toISOString(),
      reason: 'Explicit LinkFox capture; the 1688 browser duplicate gates were not applied.',
      galleryProfile: {
        fingerprint: null,
        sourceImageCount: capture.data.gallery.imageCount,
        verifiedComplete: false,
      },
      mainImageHash,
    };
  }
  let bundleDetection;
  try {
    bundleDetection = await classifyBundleSemantically({
      data, title: data.title, config: bundleClassifierConfig(config),
    });
  } catch (error) {
    bundleDetection = failedBundleDetection(error);
    request.log.warn({ err: error, offerId }, 'semantic bundle classification failed for a new LinkFox capture');
  }
  // The synthetic query keeps a "new" capture independent from the browser
  // capture of the same offer; a primary capture owns the plain offer URL.
  const sourceUrl = primaryCreate
    ? `https://detail.1688.com/offer/${offerId}.html`
    : `https://detail.1688.com/offer/${offerId}.html?capture=linkfox`;
  const saved = await db.saveProductDetail(data, sourceUrl, imageFiles, duplicateAnalysis, bundleDetection);
  if (duplicateAnalysis.mainImageHash?.dhashHex) {
    try {
      await db.upsertProductMainImageHash({
        offerId: offerKey,
        productDetailId: saved.productDetailId,
        title: data.title ?? null,
        sourceUrl: data.mainImage ?? null,
        dhashHex: duplicateAnalysis.mainImageHash.dhashHex,
        phashHex: duplicateAnalysis.mainImageHash.phashHex,
        origin: primaryCreate ? 'linkfox_primary' : 'linkfox_capture',
      });
    } catch (error) {
      request.log.error({ err: error }, 'failed to register the LinkFox main image hash');
    }
  }
  try {
    await scheduleSavedProductAudits(saved.productDetailId, { trigger: 'linkfox_capture' });
  } catch (error) {
    request.log.error({ err: error }, 'failed to schedule LinkFox capture audits');
  }
  try {
    await scheduleProductRagSync(saved.productDetailId, { trigger: 'linkfox_capture' });
  } catch (error) {
    request.log.error({ err: error }, 'failed to schedule the LinkFox capture RAG sync');
  }
  if (bundleDetection.status === 'bundle' && feishuConfigured(config)) {
    try {
      await notifyBundleCapture({
        detailId: saved.productDetailId,
        title: data.title,
        options: (data.skuOptions ?? [])
          .filter((option) => /(颜色|color|colour)/i.test(String(option?.dimensionName ?? '')))
          .map((option) => option?.text)
          .filter(Boolean),
        reason: bundleDetection.analysis?.reason ?? null,
        config,
      });
    } catch (error) {
      request.log.error({ err: error }, 'failed to send the bundle notification to Feishu');
    }
  }
  return {
    mode: primaryCreate ? 'primary' : 'new',
    productDetailId: saved.productDetailId,
    offerKey,
    linkfoxOfferId: offerId,
    imageCount: imageFiles.length,
    imageTypes,
    skuRows: data.skuRows.length,
    skuOptions: data.skuOptions.length,
    attributes: data.attributes.length,
    price: data.price,
    bundleStatus: bundleDetection.status,
    duplicateStatus: duplicateAnalysis.status,
  };
});

app.get('/api/product-details', { preHandler: requireApiKey }, async (request, reply) => {
  const offerId = request.query?.offerId || null;
  if (offerId && !/^\d{10,13}$/.test(String(offerId))) {
    return reply.code(400).send({ error: 'offerId must be a 10 to 13 digit number.' });
  }
  return db.listProductDetails({ offerId, limit: request.query?.limit, offset: request.query?.offset });
});

app.get('/api/marketing/weekly-new-products', { preHandler: requireApiKey }, async (request, reply) => {
  const from = new Date(String(request.query?.from ?? ''));
  const to = new Date(String(request.query?.to ?? ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return reply.code(400).send({ error: 'from and to must be valid ISO timestamps with from before to.' });
  }
  if (to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1000) {
    return reply.code(400).send({ error: 'The requested window cannot exceed 31 days.' });
  }
  const products = await db.listWeeklyMarketingProducts({
    from: from.toISOString(), to: to.toISOString(), limit: request.query?.limit,
  });
  return {
    from: from.toISOString(), to: to.toISOString(), count: products.length, products,
  };
});

app.get('/api/product-details/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  return detail ?? reply.code(404).send({ error: 'not_found' });
});

// Permanent deletion of one capture (all child rows cascade). The dedicated
// media folder is removed from persistent storage as well. Refuses while a
// WordPress publication still points at a live post unless ?force=true.
app.delete('/api/product-details/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const publication = await db.getWordPressPublication(id);
  if (publication?.wp_post_id && request.query?.force !== 'true') {
    return reply.code(409).send({
      error: 'publication_exists',
      message: 'Remove the WordPress product first, or pass ?force=true to delete the capture anyway.',
      wpPostId: publication.wp_post_id, wpStatus: publication.wp_status,
    });
  }
  const removed = await db.deleteProductDetail(id);
  if (!removed) return reply.code(404).send({ error: 'not_found' });
  const root = path.resolve(config.storagePath, 'product-images');
  const folders = new Set();
  for (const storagePath of removed.imageStoragePaths) {
    const folder = path.dirname(path.resolve(storagePath));
    if (folder.startsWith(`${root}${path.sep}`) && /^[A-Za-z0-9_-]{1,64}$/.test(path.basename(folder))) {
      folders.add(folder);
    }
  }
  const foldersRemoved = [];
  for (const folder of folders) {
    const entries = await fs.readdir(folder).catch(() => []);
    await fs.rm(folder, { recursive: true, force: true });
    foldersRemoved.push({ folder: path.basename(folder), files: entries.length });
  }
  return { deleted: true, ...removed, foldersRemoved };
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
  trimTerminalJobs(translationJobs);
  translationQueue.enqueue(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const translated = await translateProductDetail({ detail, targetLanguage, config: {
        apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
        complexModel: config.complexModel, storagePath: config.storagePath,
        reasoningEffort: config.reasoningEffort,
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
    allowUnverifiedGallery: body.allowUnverifiedGallery === true,
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

// Publication overview across every captured product: status totals per shop,
// plus a filterable listing. Bearer or dashboard Basic auth.
app.get('/api/wordpress/publications/summary', { preHandler: requireDashboardOrApiKey }, async () => db.summarizeWordPressPublications());

app.get('/api/wordpress/publications', { preHandler: requireDashboardOrApiKey }, async (request) => db.listWordPressPublications({
  status: request.query?.status ?? '',
  search: request.query?.search ?? '',
  limit: request.query?.limit ?? 100,
  offset: request.query?.offset ?? 0,
}));

app.get('/api/wordpress/products/resolve', { preHandler: requireApiKey }, async (request, reply) => {
  let identifier;
  try {
    identifier = parseProductResolverQuery(request.query, config.wordpressBaseUrl);
  } catch (error) {
    return reply.code(400).send({ error: 'invalid_product_identifier', message: error.message });
  }
  const lookup = localResolverLookup(identifier);
  let matches = lookup ? await db.resolveWordPressPublication(lookup) : [];
  if (matches.length > 1) {
    return reply.code(409).send({ error: 'ambiguous_product_identifier', matches: matches.length });
  }
  if (matches.length === 1) {
    return { source: 'collector_index', identifier: identifier.kind, collector: matches[0],
      wordpress: { id: matches[0].wp_post_id, style_no: matches[0].style_no,
        status: matches[0].wp_status, link: matches[0].wp_url,
        edit_link: matches[0].wp_edit_url } };
  }
  try {
    const wordpress = await resolveWordPressProduct(identifier.wordpressQuery, config);
    matches = wordpress?.id
      ? await db.resolveWordPressPublication({ wpPostId: Number(wordpress.id) }) : [];
    return { source: 'wordpress_fallback', identifier: identifier.kind,
      wordpress, collector: matches.length === 1 ? matches[0] : null };
  } catch (error) {
    request.log.warn({ err: error, identifier: identifier.kind }, 'Product resolver fallback failed');
    return reply.code(404).send({ error: 'product_not_found', message: error.message });
  }
});

app.post('/api/product-details/:id/wordpress/style-number', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const publication = await db.getWordPressPublication(detail.id);
  if (!publication?.wp_post_id) return reply.code(409).send({ error: 'wordpress_publication_required' });
  const styleNo = String(request.body?.styleNo ?? '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,39}$/.test(styleNo)) {
    return reply.code(400).send({ error: 'invalid_style_number' });
  }
  const conflicts = await db.resolveWordPressPublication({ styleNo });
  if (conflicts.some((row) => Number(row.product_detail_id) !== Number(detail.id))) {
    return reply.code(409).send({ error: 'style_number_conflict' });
  }
  try {
    const synced = await updateWordPressProductStyleNumber({ publication, styleNo, config,
      optionOverrides: await db.listProductOptionOverrides(detail.id) });
    const wp = synced.wordpress;
    const syncHash = crypto.createHash('sha256').update(JSON.stringify(synced.payload)).digest('hex');
    const saved = await db.saveWordPressPublication(detail.id, {
      translationId: publication.translation_id, externalId: publication.external_id,
      styleNo, wpPostId: wp.post_id ?? publication.wp_post_id,
      wpUrl: wp.permalink ?? publication.wp_url, wpEditUrl: wp.edit_link ?? publication.wp_edit_url,
      wpStatus: wp.status ?? publication.wp_status, syncHash, payload: synced.payload,
      result: { ...(publication.result ?? {}), ...wp }, lastError: null,
    });
    const rag = await scheduleProductRagSync(detail.id, { trigger: 'wordpress_style_number_update' });
    return { status: 'updated', productDetailId: detail.id, oldStyleNo: publication.style_no,
      styleNo: saved.style_no, wordpressPostId: saved.wp_post_id,
      ragSyncScheduled: rag.scheduled };
  } catch (error) {
    request.log.error({ err: error, productDetailId: detail.id }, 'WordPress style number update failed');
    return reply.code(502).send({ error: 'wordpress_style_number_update_failed', message: error.message });
  }
});

// A captured option label can be a bare merchant code (for example `9007`).
// The published label is rebuilt from the source SKU options on every capture,
// translation refresh, and publication, so these overrides are what makes a
// corrected display name durable. They are applied when the WordPress payload
// is assembled, which every publication path shares.
app.get('/api/product-details/:id/option-overrides', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return { productDetailId: detail.id, offerId: detail.offer_id,
    overrides: await db.listProductOptionOverrides(detail.id) };
});

app.post('/api/product-details/:id/option-overrides', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const sourceText = String(request.body?.sourceText ?? '').trim();
  const displayLabel = String(request.body?.displayLabel ?? '').trim();
  if (!sourceText || !displayLabel) {
    return reply.code(400).send({ error: 'sourceText and displayLabel are required' });
  }
  if (sourceText.length > MAX_OPTION_LABEL_LENGTH || displayLabel.length > MAX_OPTION_LABEL_LENGTH) {
    return reply.code(400).send({ error: 'sourceText and displayLabel must be 120 characters or fewer' });
  }
  try {
    const override = await db.upsertProductOptionOverride(detail.id, {
      dimensionName: request.body?.dimensionName, sourceText, displayLabel, note: request.body?.note,
    });
    return { status: 'saved', override, overrides: await db.listProductOptionOverrides(detail.id) };
  } catch (error) {
    request.log.error({ err: error, productDetailId: detail.id }, 'Option override save failed');
    return reply.code(422).send({ error: 'option_override_failed', message: error.message });
  }
});

app.delete('/api/product-details/:id/option-overrides/:overrideId', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const overrideId = Number(request.params.overrideId);
  if (!Number.isSafeInteger(overrideId) || overrideId <= 0) {
    return reply.code(400).send({ error: 'invalid_override_id' });
  }
  const deleted = await db.deleteProductOptionOverride(detail.id, overrideId);
  if (!deleted) return reply.code(404).send({ error: 'not_found' });
  return { status: 'deleted', override: deleted };
});

app.get('/api/shopify/source-match', { preHandler: requireApiKey }, async (request, reply) => {
  const wpPostId = Number(request.query?.wpPostId);
  const styleNo = String(request.query?.styleNo ?? '').trim();
  const store = String(request.query?.store ?? '').trim().toLowerCase();
  if (!Number.isSafeInteger(wpPostId) || wpPostId <= 0
      || !/^[A-Za-z0-9_-]{2,40}$/.test(styleNo)
      || !/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(store)) {
    return reply.code(400).send({ error: 'valid wpPostId, styleNo, and store are required' });
  }
  const matches = await db.findShopifySource({ wpPostId, styleNo, shopifyStore: store });
  if (matches.length === 0) return reply.code(404).send({ error: 'not_found' });
  if (matches.length !== 1) {
    return reply.code(409).send({ error: 'ambiguous_source_mapping', matches: matches.length });
  }
  return matches[0];
});

app.get('/api/product-details/:id/shopify', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const store = String(request.query?.store ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(store)) {
    return reply.code(400).send({ error: 'valid store hostname is required' });
  }
  return (await db.getShopifyPublication(detail.id, store))
    ?? reply.code(404).send({ error: 'not_found' });
});

app.post('/api/product-details/:id/shopify', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const body = request.body ?? {};
  const store = String(body.shopifyStore ?? '').trim().toLowerCase();
  const gid = String(body.shopifyProductGid ?? '').trim();
  const handle = String(body.shopifyHandle ?? '').trim();
  const url = String(body.shopifyUrl ?? '').trim();
  const productStatus = String(body.productStatus ?? '').trim().toUpperCase();
  const publicationStatus = String(body.publicationStatus ?? '').trim().toLowerCase();
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(store)
      || !/^gid:\/\/shopify\/Product\/\d+$/.test(gid)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)
      || !parsedUrl || parsedUrl.protocol !== 'https:'
      || parsedUrl.hostname.toLowerCase() !== store
      || !['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(productStatus)
      || !['published', 'unpublished'].includes(publicationStatus)) {
    return reply.code(400).send({ error: 'invalid_shopify_publication' });
  }
  const saved = await db.saveShopifyPublication(detail.id, {
    shopifyStore: store, shopifyProductGid: gid, shopifyHandle: handle,
    shopifyUrl: url, productStatus, publicationStatus,
    sourceWpPostId: Number.isSafeInteger(Number(body.sourceWpPostId))
      ? Number(body.sourceWpPostId) : null,
    sourceStyleNo: typeof body.sourceStyleNo === 'string' ? body.sourceStyleNo.trim() : null,
    syncHash: typeof body.syncHash === 'string' ? body.syncHash : null,
    payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
    result: body.result && typeof body.result === 'object' ? body.result : {},
    lastError: typeof body.lastError === 'string' ? body.lastError : null,
    verified: body.verified === true,
  });
  return reply.code(200).send(saved);
});

app.post('/api/product-details/:id/wordpress/unpublish', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const publication = await db.getWordPressPublication(detail.id);
  if (!publication?.wp_post_id) {
    return { status: 'not_published', productDetailId: detail.id, ragDeactivationScheduled: false };
  }
  const targetStatus = request.body?.status === 'private' ? 'private' : 'draft';
  try {
    const wordpress = await setWordPressProductStatus({
      postId: publication.wp_post_id, status: targetStatus, config,
    });
    const payload = { ...(publication.payload ?? {}), status: targetStatus };
    const result = { ...(publication.result ?? {}), ...wordpress, status: targetStatus };
    const syncHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const saved = await db.saveWordPressPublication(detail.id, {
      translationId: publication.translation_id,
      externalId: publication.external_id,
      styleNo: publication.style_no,
      wpPostId: publication.wp_post_id,
      wpUrl: publication.wp_url,
      wpEditUrl: publication.wp_edit_url,
      wpStatus: targetStatus,
      syncHash,
      payload,
      result,
      lastError: null,
    });
    const rag = await scheduleProductRagSync(detail.id, { trigger: 'source_delisted' });
    return {
      status: 'unpublished', productDetailId: detail.id,
      wordpressStatus: saved.wp_status, ragDeactivationScheduled: rag.scheduled,
    };
  } catch (error) {
    request.log.error({ err: error, productDetailId: detail.id }, 'WordPress unpublish failed');
    return reply.code(502).send({ error: 'wordpress_unpublish_failed', message: error.message });
  }
});

app.post('/api/product-details/:id/wordpress/preview', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const translation = await db.getLatestProductTranslation(detail.id, 'en');
  if (!translation) return reply.code(409).send({ error: 'english_translation_required' });
  try {
    const draft = await prepareWordPressProductDraft({
      detail, translation, options: wordpressPublishOptions(request.body), config,
      optionOverrides: await db.listProductOptionOverrides(detail.id),
    });
    return { payload: draft.payload, publishingImageCount: draft.publishingImages.length };
  } catch (error) {
    return reply.code(422).send({ error: 'wordpress_payload_failed', message: error.message });
  }
});

app.post('/api/product-details/:id/wordpress/publish', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const sourceListings = await db.listShopProductSources(detail.offer_id);
  const policy = evaluateShopProductPolicy(sourceListings);
  if (!policy.allowed) {
    return reply.code(422).send({
      error: 'shop_product_policy_rejected', policy: policy.policy, reason: policy.reason,
    });
  }
  if (detail.bundle_status === 'bundle' && request.body?.allowBundle !== true) {
    return reply.code(422).send({
      error: 'bundle_review_required',
      message: 'This capture mixes multiple products in one option dimension. Pass allowBundle=true to publish it as a single product.',
      bundle: detail.bundle_analysis?.rules ?? null,
    });
  }
  const translation = await db.getLatestProductTranslation(detail.id, 'en');
  if (!translation) return reply.code(409).send({ error: 'english_translation_required' });
  const id = crypto.randomUUID();
  const options = wordpressPublishOptions(request.body);
  const job = { id, productDetailId: detail.id, offerId: detail.offer_id,
    status: 'queued', publishStatus: options.status, createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, publicationId: null, result: null, error: null };
  wordpressJobs.set(id, job);
  trimTerminalJobs(wordpressJobs);
  wordpressPublishQueue.enqueue(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    let draft;
    try {
      const published = await publishProductToWordPress({ detail, translation, options, config,
        optionOverrides: await db.listProductOptionOverrides(detail.id) });
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
  trimTerminalJobs(wordpressPublicationDateJobs);
  wordpressMaintenanceQueue = wordpressMaintenanceQueue.catch(() => {}).then(async () => {
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

app.post('/api/wordpress/arrival-dates/backfill', { preHandler: requireApiKey }, async (_request, reply) => {
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', totalPublished: 0, eligible: 0, updated: 0,
    skippedMissingListingTime: 0, failed: 0,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null, errors: [] };
  wordpressArrivalDateJobs.set(id, job);
  trimTerminalJobs(wordpressArrivalDateJobs);
  wordpressMaintenanceQueue = wordpressMaintenanceQueue.catch(() => {}).then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const rows = await db.listWordPressArrivalDates();
      job.totalPublished = rows.length;
      const eligible = rows.map((row) => ({ ...row, arrivalDate: get1688ArrivalDate({
        publication_date_source: row.listing_time ? '1688_listing_time' : '',
        publication_date: row.listing_time,
      }) })).filter((row) => row.arrivalDate);
      job.eligible = eligible.length;
      job.skippedMissingListingTime = rows.length - eligible.length;
      for (let offset = 0; offset < eligible.length; offset += 5) {
        const batch = eligible.slice(offset, offset + 5);
        await Promise.all(batch.map(async (row) => {
          try {
            const result = await setWordPressProductArrivalDate({
              postId: row.wp_post_id, externalId: row.external_id,
              arrivalDate: row.arrivalDate, config,
            });
            if (String(result?.arrival_date || '') !== row.arrivalDate) {
              throw new Error('WordPress did not confirm the requested arrival date.');
            }
            await db.saveWordPressArrivalDate(row.product_detail_id, row.arrivalDate);
            job.updated += 1;
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

app.get('/api/wordpress-arrival-date-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = wordpressArrivalDateJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

app.post('/api/wordpress/prices/audit-and-repair', { preHandler: requireApiKey }, async (_request, reply) => {
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', total: 0, verified: 0, unresolved: 0,
    storedChanged: 0, publishedAffected: 0, wordpressUpdated: 0, failed: 0,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null, errors: [] };
  wordpressPriceRepairJobs.set(id, job);
  trimTerminalJobs(wordpressPriceRepairJobs);
  wordpressMaintenanceQueue = wordpressMaintenanceQueue.catch(() => {}).then(async () => {
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

app.get('/api/wordpress/best-sellers/preview', { preHandler: requireApiKey }, async (request) => {
  const plan = await buildBestSellerPlan(request.query?.limit);
  return {
    target: plan.target,
    eligiblePublished: plan.eligiblePublished,
    allocations: plan.allocations,
    selected: plan.selected.map((item) => ({
      shopName: item.shop_name,
      domain: item.domain,
      styleNo: item.style_no,
      wordpressUrl: item.wp_url,
      saleQuantity: item.sale_quantity,
      saleQuantityText: item.sale_quantity_text,
      listingTime: item.listing_time,
    })),
  };
});

app.post('/api/wordpress/best-sellers/rebuild', { preHandler: requireApiKey }, async (request, reply) => {
  const id = crypto.randomUUID();
  const limit = Math.min(Math.max(Number(request.body?.limit) || 36, 1), 48);
  const job = { id, status: 'queued', limit, createdAt: new Date().toISOString(),
    startedAt: null, completedAt: null, plan: null, result: null, error: null };
  wordpressBestSellerJobs.set(id, job);
  trimTerminalJobs(wordpressBestSellerJobs);
  wordpressMaintenanceQueue = wordpressMaintenanceQueue.then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const plan = await buildBestSellerPlan(limit);
      job.plan = {
        target: plan.target,
        eligiblePublished: plan.eligiblePublished,
        allocations: plan.allocations,
      };
      const wordpress = await replaceWordPressBestSellers({
        postIds: plan.selected.map((item) => item.wp_post_id), config,
      });
      job.result = { wordpress, selected: plan.selected.map((item) => ({
        shopName: item.shop_name, domain: item.domain, styleNo: item.style_no,
        wordpressUrl: item.wp_url, saleQuantity: item.sale_quantity,
      })) };
      job.status = wordpress.failed ? 'completed_with_errors' : 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
    } finally {
      job.completedAt = new Date().toISOString();
    }
  }).catch((error) => app.log.error({ err: error }, 'Best Sellers rebuild queue failed'));
  return reply.code(202).send(job);
});

app.get('/api/wordpress-best-seller-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = wordpressBestSellerJobs.get(request.params.id);
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
        apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
        model: config.visionModel, storagePath: config.storagePath,
        reasoningEffort: config.reasoningEffort,
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

// Captures the description (detail) images of a saved product on demand. The
// images are stored with the collector (files + product_detail_images rows) and
// are intentionally not pushed to WordPress.
app.post('/api/product-details/:id/detail-images', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
  const detailId = Number(request.params.id);
  if (!Number.isInteger(detailId) || detailId <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(detailId).catch(() => null);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const targetUrl = detail.canonical_url || detail.source_url
    || (detail.offer_id ? `https://detail.1688.com/offer/${detail.offer_id}.html` : null);
  if (!targetUrl) return reply.code(400).send({ error: 'detail_has_no_source_url' });

  const id = crypto.randomUUID();
  const job = { id, status: 'queued', detailId, offerId: detail.offer_id ?? null, url: targetUrl,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    container: null, imageCount: null, images: null, error: null };
  detailImageJobs.set(id, job);
  trimTerminalJobs(detailImageJobs);
  multimodalAuditQueue = multimodalAuditQueue.catch(() => {}).then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const result = await collector.captureDetailImages(targetUrl, { debug: Boolean(request.body?.debug) });
      await db.saveDetailImages(detailId, result.images ?? []);
      job.container = result.container ?? null;
      job.containerFrame = result.containerFrame ?? null;
      job.frameSummaries = result.frameSummaries ?? null;
      job.tabLabel = result.tabLabel ?? null;
      job.imageCount = result.imageCount ?? 0;
      job.debugArtifacts = result.debugArtifacts ?? null;
      job.images = (result.images ?? []).map((image) => ({ sourceUrl: image.sourceUrl,
        mimeType: image.mimeType ?? null, byteSize: image.byteSize ?? null,
        storagePath: image.storagePath ?? null, sortOrder: image.sortOrder ?? 0 }));
      job.status = 'completed';
      job.error = job.imageCount ? null : 'No description images were found on the page.';
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
    } finally {
      job.completedAt = new Date().toISOString();
    }
  });
  return reply.code(202).send(job);
});

app.get('/api/product-detail-image-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = detailImageJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// Public read-only access to locally stored Alibaba images.  Product photography
// is public content, but the 1688 CDN rejects foreign Referer headers (hotlink
// protection), so browsers must load the stored copy from this host instead.
const IMAGE_CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif' };

app.get('/api/product-images/:folder/:fileName', async (request, reply) => {
  const folder = String(request.params.folder ?? '');
  const fileName = String(request.params.fileName ?? '');
  const extension = path.extname(fileName).toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(folder) || !/^[A-Za-z0-9._-]{1,180}$/.test(fileName)
      || !IMAGE_CONTENT_TYPES[extension] || fileName.includes('..')) {
    return reply.code(400).send({ error: 'invalid_image_path' });
  }
  const root = path.resolve(config.storagePath, 'product-images');
  const filePath = path.resolve(root, folder, fileName);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    return reply.code(400).send({ error: 'invalid_image_path' });
  }
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    return reply.code(404).send({ error: 'not_found' });
  }
  // Optional on-the-fly thumbnail (`?w=`): stored captures are full-size
  // originals, so review pages request a small width instead of the original.
  const requestedWidth = Number(request.query?.w);
  let contentType = IMAGE_CONTENT_TYPES[extension];
  if (Number.isFinite(requestedWidth) && requestedWidth > 0) {
    const width = Math.min(Math.max(Math.round(requestedWidth), 16), 640);
    try {
      bytes = await sharp(bytes, { failOn: 'none' })
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      contentType = 'image/webp';
    } catch { /* fall back to the original bytes */ }
  }
  reply.header('cache-control', 'public, max-age=31536000, immutable');
  return reply.type(contentType).send(bytes);
});

app.get('/api/product-details/:id/sku-audits', { preHandler: requireApiKey }, async (request, reply) => {  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return db.listProductAudits('sku', detail.id, request.query?.limit);
});

// Read the live offer's embedded SKU model (option x size with price/stock)
// straight from the 1688 page. Read-only; runs in the shared collector browser.
app.post('/api/product-details/:id/dom-sku-matrix', { preHandler: [requireDashboardOrApiKey, requireCollectorMode] }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id).catch(() => null);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const targetUrl = detail.canonical_url || detail.source_url
    || (detail.offer_id ? `https://detail.1688.com/offer/${detail.offer_id}.html` : null);
  if (!targetUrl) return reply.code(400).send({ error: 'detail_has_no_source_url' });
  try {
    const result = await collector.extractLiveSkuMatrix(targetUrl);
    if (result.status === 'requires_auth') return reply.code(409).send({ error: 'requires_auth' });
    if (!result.matrix) return reply.code(502).send({ error: 'sku_matrix_unavailable', finalUrl: result.finalUrl });
    return {
      productDetailId: id, offerId: detail.offer_id, url: targetUrl,
      fetchedAt: new Date().toISOString(), matrix: result.matrix,
    };
  } catch (error) {
    request.log.error({ err: error, productDetailId: id }, 'live SKU matrix fetch failed');
    return reply.code(502).send({ error: 'sku_matrix_fetch_failed', message: error.message });
  }
});

// Repair one product's variant rows from the live embedded matrix: rewrites
// product_detail_skus (colour x size), refreshes the stored matrix/dimensions/
// prices and re-runs the bundle detector. Used by the portal repair pass.
app.post('/api/product-details/:id/repair-skus-from-matrix', { preHandler: [requireDashboardOrApiKey, requireCollectorMode] }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id).catch(() => null);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const targetUrl = detail.canonical_url || detail.source_url
    || (detail.offer_id ? `https://detail.1688.com/offer/${detail.offer_id}.html` : null);
  if (!targetUrl) return reply.code(400).send({ error: 'detail_has_no_source_url' });
  let live;
  try {
    live = await collector.extractLiveSkuMatrix(targetUrl);
  } catch (error) {
    return reply.code(502).send({ error: 'sku_matrix_fetch_failed', message: error.message });
  }
  if (live.status === 'requires_auth') return reply.code(409).send({ error: 'requires_auth' });
  if (!live.matrix) return reply.code(502).send({ error: 'sku_matrix_unavailable', finalUrl: live.finalUrl });
  const rows = buildSkuRowsFromSkuModel(live.matrix);
  if (!rows.length) return reply.code(422).send({ error: 'no_sku_rows_from_matrix' });
  const dimensions = (Array.isArray(live.matrix.dimensions) ? live.matrix.dimensions : []).map((dimension) => ({
    name: String(dimension?.name ?? '').trim(),
    values: (Array.isArray(dimension?.values) ? dimension.values : []).map((value) => String(value).trim()).filter(Boolean),
  })).filter((dimension) => dimension.name && dimension.values.length);
  const prices = rows.map((row) => Number(row.price)).filter((value) => Number.isFinite(value) && value >= 0);
  const priceMin = prices.length ? Math.min(...prices) : null;
  const priceMax = prices.length ? Math.max(...prices) : null;
  const skuMatrix = {
    dimensions, rows: live.matrix.rows, priceScale: live.matrix.priceScale ?? null,
    fetchedAt: new Date().toISOString(),
  };
  await db.updateProductSkusFromMatrix(id, { rows, dimensions, skuMatrix, priceMin, priceMax });
  let bundleOutcome = null;
  try {
    const detection = await classifyBundleSemantically({
      data: { skuOptions: detail.raw_data?.skuOptions ?? [], skuDimensions: dimensions, skuMatrix },
      title: detail.title, config: bundleClassifierConfig(config),
    });
    await db.saveProductBundleStatus(id, detection);
    bundleOutcome = { status: detection.status, reason: detection.analysis?.reason ?? null };
  } catch (error) {
    // Keep the previous verdict when the model is unavailable.
    bundleOutcome = { status: null, error: String(error?.message || error).slice(0, 200) };
  }
  return {
    productDetailId: id, rows: rows.length, dimensions: dimensions.map((dimension) => dimension.name),
    priceMin, priceMax, bundle: bundleOutcome.status, bundleError: bundleOutcome.error ?? undefined,
  };
});

// Every collector-tracked portal publication, with a repair flag for
// multi-colour products whose stored rows still lack the colour dimension.
app.get('/api/portal/repair-candidates', { preHandler: requireDashboardOrApiKey }, async () => {
  const rows = await db.listPortalRepairCandidates();
  const items = rows.map((row) => {
    const dimensions = Array.isArray(row.sku_dimensions) ? row.sku_dimensions : [];
    const nonSize = dimensions.filter((dimension) => !/(尺码|尺寸|码数|size)/i.test(String(dimension?.name || '')));
    const multiValue = nonSize.some((dimension) => (Array.isArray(dimension?.values) ? dimension.values.length : 0) >= 2);
    const matrixRows = Array.isArray(row.sku_matrix?.rows) ? row.sku_matrix.rows : [];
    const matrixHasNonSize = matrixRows.some((matrixRow) =>
      Object.keys(matrixRow?.options ?? {}).some((name) => !/(尺码|尺寸|码数|size)/i.test(name)));
    const needsRepair = row.bundle_status !== 'bundle' && multiValue && !matrixHasNonSize;
    return {
      detailId: row.id, offerId: row.offer_id, styleNo: row.style_no, title: row.title,
      bundleStatus: row.bundle_status, wpStatus: row.wp_status, wpPostId: row.wp_post_id, wpUrl: row.wp_url,
      portalProductId: row.portal_product_id,
      optionValues: nonSize.flatMap((dimension) => Array.isArray(dimension?.values) ? dimension.values : []).slice(0, 8),
      matrixHasNonSize, needsRepair,
    };
  });
  return { count: items.length, needsRepair: items.filter((item) => item.needsRepair).length, items };
});

// Public path for a stored product image file (used by the products page).
function imagePublicPath(storagePath) {
  if (!storagePath) return null;
  const normalized = String(storagePath).replace(/\\/g, '/');
  const file = normalized.split('/').pop();
  const folder = normalized.split('/').slice(-2)[0];
  if (!file || !folder) return null;
  return '/api/product-images/' + encodeURIComponent(folder) + '/' + encodeURIComponent(file);
}

// All captured products (read-only variants view): option names with swatch
// images, price range, publication state, source shop and 1688 listing status.
function toProductCatalogItem(row) {
  const images = Array.isArray(row.images) ? row.images : [];
  const bySource = new Map();
  for (const image of images) {
    if (image?.source) bySource.set(String(image.source).trim(), image);
  }
  const skuOptions = Array.isArray(row.sku_options) ? row.sku_options : [];
  const skuDimensions = Array.isArray(row.sku_dimensions) ? row.sku_dimensions : [];
  const dimOrder = [];
  const dimMap = new Map();
  for (const option of skuOptions) {
    const dim = String(option?.dimensionName || '未命名维度');
    if (!dimMap.has(dim)) { dimMap.set(dim, []); dimOrder.push(dim); }
    const source = option?.image ? String(option.image).trim() : null;
    const hit = source ? bySource.get(source) : null;
    const base = hit ? imagePublicPath(hit.path) : null;
    dimMap.get(dim).push({ text: String(option?.text || ''), local: base ? `${base}?w=64` : null, source });
  }
  for (const dimension of skuDimensions) {
    const name = String(dimension?.name || '');
    if (!name || dimMap.has(name)) continue;
    const values = Array.isArray(dimension?.values)
      ? dimension.values.filter((value) => value !== null && value !== '') : [];
    if (!values.length) continue;
    dimOrder.push(name);
    dimMap.set(name, values.map((value) => ({ text: String(value), local: null, source: null })));
  }
  const gallery = images
    .filter((image) => image?.type === 'main' || image?.type === 'gallery')
    .map((image) => {
      const base = imagePublicPath(image.path);
      return { id: String(image.id), type: image.type,
        thumb: base ? `${base}?w=160` : (image.source || null) };
    });
  return {
    id: row.id,
    offerId: row.offer_id,
    title: row.title,
    date: row.last_crawled_at ? String(row.last_crawled_at).slice(0, 10) : '',
    status: row.bundle_status || '',
    priceMin: row.price_min === null ? null : Number(row.price_min),
    priceMax: row.price_max === null ? null : Number(row.price_max),
    currency: row.currency || 'CNY',
    moq: row.moq === null ? null : Number(row.moq),
    skuRows: row.sku_rows ?? 0,
    colorCount: Number(row.color_count) || 0,
    bundleManual: row.bundle_manual_status || null,
    hasSplitPlan: row.has_split_plan === true,
    shopId: row.shop_id === null || row.shop_id === undefined ? null : Number(row.shop_id),
    shopName: row.shop_name || null,
    listingStatus: row.availability_status || null,
    delistedAt: row.delisted_at || null,
    styleNo: row.style_no || null,
    wpStatus: row.wp_status || null,
    wpUrl: row.wp_url || null,
    cover: gallery.length ? gallery[0].thumb : null,
    gallery,
    dims: dimOrder.map((name) => ({ name, options: dimMap.get(name) })),
  };
}

app.get('/api/product-catalog', { preHandler: requireDashboardOrApiKey }, async (request) => {
  const colorsRaw = String(request.query?.colors ?? '').trim();
  const colors = /^[0-6]$/.test(colorsRaw) ? Number(colorsRaw) : 0;
  const wp = ['publish', 'unpublished'].includes(String(request.query?.wp ?? '').trim())
    ? String(request.query.wp).trim() : '';
  const bundle = ['bundle', 'clear'].includes(String(request.query?.bundle ?? '').trim())
    ? String(request.query.bundle).trim() : '';
  const shop = String(request.query?.shop ?? '').trim().slice(0, 24);
  const result = await db.listProductCatalog({
    limit: request.query?.limit ?? 100,
    offset: request.query?.offset ?? 0,
    search: request.query?.search ?? '',
    colors,
    wp,
    bundle,
    shop,
  });
  return {
    count: result.filteredTotal, total: result.total,
    colorCounts: result.colorCounts,
    wpCounts: result.wpCounts,
    bundleCounts: result.bundleCounts,
    shopCounts: result.shopCounts,
    manualBundleCount: result.manualBundleCount,
    limit: result.limit, offset: result.offset,
    items: result.items.map(toProductCatalogItem),
  };
});

// Recompute bundle status for captures that predate the flag (semantic
// classification only; failures keep the previous verdict).
app.post('/api/bundle-audit/backfill', { preHandler: requireApiKey }, async (request) => {
  const limit = Number(request.body?.limit) > 0 ? Math.min(Number(request.body.limit), 2000) : 500;
  const rows = await db.listDetailsMissingBundleAudit(limit);
  let bundles = 0; let clear = 0; let failed = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(6, rows.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= rows.length) return;
      const row = rows[index];
      try {
        let detection = null;
        for (let attempt = 1; attempt <= 2 && !detection; attempt += 1) {
          try {
            detection = await classifyBundleSemantically({
              data: {
                skuOptions: row.sku_options ?? [],
                skuDimensions: row.sku_dimensions ?? [],
                skuMatrix: row.sku_matrix ?? null,
              },
              title: row.title, config: bundleClassifierConfig(config),
            });
          } catch (error) {
            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 2500));
              continue;
            }
            failed += 1;
            request.log.warn({ err: error, productDetailId: row.id }, 'bundle classification failed; previous verdict kept');
          }
        }
        if (!detection) continue;
        await db.saveProductBundleStatus(row.id, detection);
        if (detection.status === 'bundle') bundles += 1; else clear += 1;
      } catch (error) {
        failed += 1;
        request.log.error({ err: error, productDetailId: row.id }, 'bundle audit backfill failed');
      }
    }
  });
  await Promise.all(workers);
  return { scanned: rows.length, bundles, clear, failed, more: rows.length >= limit };
});

const PERCEPTUAL_HASH_IMAGE_HOSTS = ['alicdn.com', '1688.com', 'taobao.com', 'tmall.com', 'yiswim.cloud'];

function isAllowedPerceptualHashImageUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return PERCEPTUAL_HASH_IMAGE_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

app.post('/api/image-hashes/import', { preHandler: requireApiKey }, async (request, reply) => {
  const items = Array.isArray(request.body?.items) ? request.body.items : [];
  if (!items.length) return reply.code(400).send({ error: 'items[] is required.' });
  const result = await db.importPerceptualHashes(items);
  return { ok: true, ...result };
});

app.get('/api/image-hashes/summary', { preHandler: requireApiKey }, async () => db.getPerceptualHashSummary());

app.post('/api/image-hashes/check', { preHandler: requireApiKey }, async (request, reply) => {
  const offerId = request.body?.offerId ? String(request.body.offerId) : null;
  const imageUrl = String(request.body?.imageUrl || '');
  if (!isAllowedPerceptualHashImageUrl(imageUrl)) {
    return reply.code(400).send({ error: 'imageUrl must be an https image URL on a supported CDN host.' });
  }
  let bytes = null;
  try {
    const response = await fetch(imageUrl, {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://detail.1688.com/' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return reply.code(502).send({ error: `image_fetch_failed_${response.status}` });
    const contentType = response.headers.get('content-type')?.split(';')[0] || '';
    if (!contentType.startsWith('image/')) return reply.code(502).send({ error: 'not_an_image' });
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return reply.code(502).send({ error: `image_fetch_failed: ${String(error?.message ?? error).slice(0, 200)}` });
  }
  const hashes = await computeImageHashes(bytes);
  const matches = await db.findMainImagePerceptualExactMatches({ offerId, ...hashes });
  return { match: matches.length > 0, hashes, matches };
});

app.post('/api/image-audit/test', { preHandler: requireApiKey }, async (request, reply) => {
  if (!Array.isArray(request.body?.images) || request.body.images.length < 1 || request.body.images.length > 30) {
    return reply.code(400).send({ error: 'images must contain 1 to 30 ordered persistent-storage image paths.' });
  }
  try {
    return await analyzeGalleryImages({ images: request.body.images, config: {
      apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
      visionModel: config.visionModel, complexModel: config.complexModel,
      reasoningEffort: config.reasoningEffort,
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
  trimTerminalJobs(imageAuditJobs);
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
            apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
            visionModel: config.visionModel, complexModel: config.complexModel,
            reasoningEffort: config.reasoningEffort,
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
  trimTerminalJobs(skuAuditJobs);
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
            config: { apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
              visionModel: config.visionModel, complexModel: config.complexModel,
              reasoningEffort: config.reasoningEffort },
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
  if (typeof url !== 'string' || !isAllowed1688Url(url) || !is1688ShopUrl(url)) {
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
  if (typeof url !== 'string' || !isAllowed1688Url(url) || !is1688ShopUrl(url)) {
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

async function workerLoop(queue, workerIndex = 0) {
  while (workerRunning) {
    if (!workerEnabled) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    workerActiveCount += 1;
    let job;
    try {
      job = await db.claimNextJob(queue);
    } catch (error) {
      workerActiveCount -= 1;
      throw error;
    }
    if (!job) {
      workerActiveCount -= 1;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    try {
      const result = await collector.capture(job);
      if (result.extractedData?.pageType === 'shop') {
        await db.upsertShopProfile(result.extractedData);
      } else if (result.extractedData?.pageType === 'shop-offer-collection') {
        const reconciliation = await db.saveShopScan(job.id, result.extractedData, {
          completeInventory: job.options?.allPages === true,
        });
        result.extractedData.reconciliation = reconciliation;
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
          let bundleDetection;
          try {
            bundleDetection = await classifyBundleSemantically({
              data: result.extractedData,
              title: result.extractedData?.title,
              config: bundleClassifierConfig(config),
            });
          } catch (error) {
            app.log.warn({ err: error }, 'semantic bundle classification failed for a browser capture');
            bundleDetection = failedBundleDetection(error);
          }
          const saved = await db.saveProductDetail(
            result.extractedData, job.url, result.extractedData.localImages ?? [], duplicateAnalysis,
            bundleDetection,
          );
          result.extractedData.bundleDetection = bundleDetection;
          if (duplicateAnalysis.mainImageHash?.dhashHex) {
            try {
              await db.upsertProductMainImageHash({
                offerId: result.extractedData?.offerId,
                productDetailId: saved.productDetailId,
                title: result.extractedData?.title ?? null,
                sourceUrl: result.extractedData?.mainImage ?? null,
                dhashHex: duplicateAnalysis.mainImageHash.dhashHex,
                phashHex: duplicateAnalysis.mainImageHash.phashHex,
                origin: 'capture',
              });
            } catch (error) {
              app.log.error({ err: error }, 'failed to register main image perceptual hash');
            }
          }
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
          if (bundleDetection.status === 'bundle' && feishuConfigured(config)) {
            try {
              await notifyBundleCapture({
                detailId: saved.productDetailId,
                title: result.extractedData?.title,
                options: (result.extractedData?.skuOptions ?? [])
                  .filter((option) => /(颜色|color|colour)/i.test(String(option?.dimensionName ?? '')))
                  .map((option) => option?.text)
                  .filter(Boolean),
                reason: bundleDetection.analysis?.reason ?? null,
                config,
              });
            } catch (error) {
              app.log.error({ err: error }, 'failed to send the bundle notification to Feishu');
            }
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
      workerActiveCount -= 1;
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
if (config.savedAuditsStartPaused) savedAuditQueue.pause();
try {
  const recoveredAuditCount = await recoverSavedProductAudits();
  app.log.info({ recoveredAuditCount, concurrency: config.savedAuditConcurrency },
    'pending saved product audits recovered');
} catch (error) {
  app.log.error({ err: error }, 'failed to recover pending saved product audits');
}
try {
  const hashBackfill = await db.backfillProductImageHashes();
  app.log.info(hashBackfill, 'product image hashes ready for duplicate detection');
} catch (error) {
  app.log.error({ err: error }, 'product image hash backfill failed; new captures will still be hashed');
}
await collector.start();
await app.listen({ port: config.port, host: '0.0.0.0' });
const workers = [workerLoop('general', 0),
  ...Array.from({ length: config.detailCaptureConcurrency }, (_, index) =>
    workerLoop('product_detail', index + 1))];
Promise.all(workers).catch((error) => {
  app.log.fatal(error, 'worker stopped');
  process.exitCode = 1;
});
