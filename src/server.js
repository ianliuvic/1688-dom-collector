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
  resolveWordPressProduct, updateWordPressProductStyleNumber, buildWearHongxiuPricing,
  fetchWordPressProductStatuses, deleteWordPressProduct,
  publishSplitProductsToWordPress, repairSplitKeeperCategories,
  resolvePublishImageRows, dedupePublishImageRows, computePublishImageRows } from './wordpress-publisher.js';
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
import { analyzeBundleSplit, recomputePlan, generateSplitContents, normalizeSplitContents, applyVariantDropPolicy, classifyNonProductImages, regenerateSplitCopy } from './bundle-splitter.js';
import { normalizeVariants } from './variant-normalizer.js';
import { dedupeImagesByHash, dedupeImagesWithLlm, normalizedSourceImageKey } from './image-dedupe.js';
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
  translationImageLimit: Math.min(Math.max(Number(process.env.TRANSLATION_IMAGE_LIMIT) || 60, 1), 100),
  translationConcurrency: Math.min(Math.max(Number(process.env.TRANSLATION_CONCURRENCY) || 1, 1), 10),
  savedAuditConcurrency: Math.min(Math.max(Number(process.env.SAVED_AUDIT_CONCURRENCY) || 3, 1), 5),
  savedAuditsStartPaused: process.env.SAVED_AUDITS_START_PAUSED === 'true',
  wordpressPublishConcurrency: Math.min(Math.max(Number(process.env.WORDPRESS_PUBLISH_CONCURRENCY) || 3, 1), 5),
  modelImageTransport: process.env.MODEL_IMAGE_TRANSPORT === 'persistent_storage'
    ? 'persistent_storage' : 'source_url',
  wordpressBaseUrl: process.env.WORDPRESS_BASE_URL,
  wordpressUsername: process.env.WORDPRESS_USERNAME,
  wordpressApplicationPassword: process.env.WORDPRESS_APPLICATION_PASSWORD,
  wpStatusEventToken: process.env.WP_STATUS_EVENT_TOKEN?.trim() || '',
  wpStatusReconcileMinutes: Math.min(Math.max(Number(process.env.WP_STATUS_RECONCILE_MINUTES) || 15, 1), 1440),
  novncUsername: process.env.NOVNC_USERNAME || '',
  novncPassword: process.env.NOVNC_PASSWORD || '',
  productsRagApiUrl: process.env.PRODUCTS_RAG_API_URL || '',
  productsRagAdminToken: process.env.PRODUCTS_RAG_ADMIN_TOKEN || '',
  productsRagSyncConcurrency: Math.min(Math.max(Number(process.env.PRODUCTS_RAG_SYNC_CONCURRENCY) || 2, 1), 5),
  detailCaptureConcurrency: Math.min(Math.max(Number(process.env.DETAIL_CAPTURE_CONCURRENCY) || 1, 1), 5),
  portalApiUrl: process.env.PORTAL_API_URL?.trim() || '',
  portalAdminSecret: process.env.PORTAL_ADMIN_SECRET || '',
  portalStagingApiUrl: process.env.PORTAL_STAGING_API_URL?.trim() || '',
  portalStagingAdminSecret: process.env.PORTAL_STAGING_ADMIN_SECRET || '',
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

async function buildBestSellerPlan(limit = 48) {
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

// WordPress pushes product status changes here with a dedicated token, kept
// separate from the collector admin key so the site cannot call other APIs.
function requireWpStatusEventToken(request, reply, done) {
  if (!config.wpStatusEventToken) {
    reply.code(503).send({ error: 'wp_status_events_not_configured' });
    return;
  }
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(config.wpStatusEventToken);
  if (suppliedBuffer.length !== expectedBuffer.length
      || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    reply.code(401).send({ error: 'unauthorized' });
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

async function importWordPressProductToPortal(identifier, portal = { url: config.portalApiUrl, secret: config.portalAdminSecret }, options = {}) {
  const requestBody = { identifiers: [identifier] };
  if (Array.isArray(options.mediaUrls) && options.mediaUrls.length) requestBody.mediaUrls = options.mediaUrls;
  const response = await fetch(new URL('/api/v1/admin/catalog/import/wordpress', portal.url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${portal.secret}`,
    },
    body: JSON.stringify(requestBody),
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

/** Apply a chosen portal image set (order + visibility) to one portal catalog product. */
async function updatePortalCatalogMedia(portal, portalProductId, product, images) {
  const media = Array.isArray(product?.media) ? product.media : [];
  if (!portalProductId || !media.length || !Array.isArray(images) || !images.length) return null;
  const requested = new Map();
  for (const entry of images.slice(0, 500)) {
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!url) continue;
    requested.set(url, (requested.get(url) ?? false) || entry.visible !== false);
  }
  if (!requested.size) return null;
  const urlById = new Map(media.map((item) => [item.id, item.url ?? '']));
  const expectedOrder = new Map([...requested.keys()].map((url, index) => [url, index]));
  const visibleIds = [];
  const hiddenIds = [];
  const mediaVisibility = [];
  for (const item of media) {
    const explicit = requested.has(item.url ?? '');
    const visible = explicit ? requested.get(item.url ?? '') : true;
    mediaVisibility.push({ id: item.id, visible });
    (visible ? visibleIds : hiddenIds).push(item.id);
  }
  visibleIds.sort((left, right) => {
    const leftIndex = expectedOrder.has(urlById.get(left)) ? expectedOrder.get(urlById.get(left)) : expectedOrder.size;
    const rightIndex = expectedOrder.has(urlById.get(right)) ? expectedOrder.get(urlById.get(right)) : expectedOrder.size;
    return leftIndex - rightIndex;
  });
  const response = await fetch(new URL(`/api/v1/admin/catalog/${encodeURIComponent(portalProductId)}`, portal.url), {
    method: 'PATCH',
    headers: { authorization: `Bearer ${portal.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mediaVisibility, mediaOrder: [...visibleIds, ...hiddenIds] }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? (typeof payload?.error === 'string' ? payload.error : null)
      ?? `Portal media update returned HTTP ${response.status}`;
    const error = new Error(String(message));
    error.status = 502;
    error.code = 'portal_media_update_failed';
    throw error;
  }
  return { visible: visibleIds.length, hidden: hiddenIds.length };
}

/**
 * Assign per-variant images to a portal catalog product. `variantImages` is the
 * portal's admin PATCH format: [{ id, imageUrl }] and lands on the variant's
 * default image (the value that pre-fills the customer's variant image picker).
 */
async function updatePortalCatalogVariants(portal, portalProductId, variantImages) {
  if (!portalProductId || !Array.isArray(variantImages) || !variantImages.length) return null;
  const response = await fetch(new URL(`/api/v1/admin/catalog/${encodeURIComponent(portalProductId)}`, portal.url), {
    method: 'PATCH',
    headers: { authorization: `Bearer ${portal.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ variantImages: variantImages.slice(0, 250) }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? (typeof payload?.error === 'string' ? payload.error : null)
      ?? `Portal variant image update returned HTTP ${response.status}`;
    const error = new Error(String(message));
    error.status = 502;
    error.code = 'portal_variant_images_update_failed';
    throw error;
  }
  return { updated: Math.min(variantImages.length, 250) };
}

/** Normalise the selection page's per-colour variant image assignments. */
function normalizeVariantImageAssignments(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const list = [];
  for (const entry of value.slice(0, 250)) {
    const color = String(entry?.color ?? '').trim();
    const url = String(entry?.url ?? '').trim();
    if (!color || !/^https?:\/\//i.test(url) || url.length > 2000) continue;
    const key = color.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ color, url });
  }
  return list;
}

/**
 * Resolve colour assignments to portal variant ids (matching the collector's
 * composed variant SKUs against the imported variants' supplier SKUs) and apply
 * them. Unmatched colours are reported back instead of guessed.
 */
async function applyPortalVariantImages(portal, product, assignments, productDetailId) {
  if (!product?.id || !assignments.length) return null;
  const skuData = await db.getSelectionProductSkus(productDetailId).catch(() => null);
  const colorBySku = new Map();
  for (const sku of skuData?.skus ?? []) {
    const skuCode = String(sku.variantSku ?? '').trim().toLowerCase();
    const color = String(sku.color ?? '').trim();
    if (skuCode && color && !colorBySku.has(skuCode)) colorBySku.set(skuCode, color);
  }
  const variantIdsByColor = new Map();
  for (const variant of Array.isArray(product.variants) ? product.variants : []) {
    const skuCode = String(variant?.supplierSku ?? '').trim().toLowerCase();
    const color = skuCode ? colorBySku.get(skuCode) : null;
    if (!color || !variant?.id) continue;
    const key = color.toLowerCase();
    if (!variantIdsByColor.has(key)) variantIdsByColor.set(key, []);
    variantIdsByColor.get(key).push(variant.id);
  }
  const patch = [];
  const matchedColors = [];
  const unmatchedColors = [];
  for (const assignment of assignments) {
    const ids = variantIdsByColor.get(assignment.color.toLowerCase()) ?? [];
    if (!ids.length) { unmatchedColors.push(assignment.color); continue; }
    matchedColors.push(assignment.color);
    for (const id of ids) patch.push({ id, imageUrl: assignment.url });
  }
  if (!patch.length) return { colors: [], unmatchedColors, variants: 0, updated: 0 };
  const updated = await updatePortalCatalogVariants(portal, product.id, patch);
  return { colors: matchedColors, unmatchedColors, variants: patch.length, updated: updated?.updated ?? 0 };
}

/** Import one collector product into the portal catalog, optionally applying image order/selection. */
async function publishProductToPortal(productDetailId, options = {}) {
  const target = options.target === 'production' ? 'production' : 'staging';
  const portal = target === 'production'
    ? { name: 'production', url: config.portalApiUrl, secret: config.portalAdminSecret }
    : { name: 'staging', url: config.portalStagingApiUrl, secret: config.portalStagingAdminSecret };
  if (!portal.url || !portal.secret) {
    const error = new Error(`${target}_portal_not_configured`);
    error.status = 503;
    error.code = 'portal_not_configured';
    throw error;
  }
  const detail = await db.getProductDetail(productDetailId);
  if (!detail) {
    const error = new Error('product_not_found');
    error.status = 404;
    error.code = 'product_not_found';
    throw error;
  }
  const publication = await db.getWordPressPublication(productDetailId);
  if (!publication?.wp_post_id && !publication?.style_no) {
    const error = new Error('wordpress_publication_required');
    error.status = 409;
    error.code = 'wordpress_publication_required';
    throw error;
  }
  const previous = await db.getPortalPublication(productDetailId);
  const chosenImages = Array.isArray(options.images) && options.images.length
    ? options.images
    : (Array.isArray(previous?.result?.mediaImages) && previous.result.mediaImages.length ? previous.result.mediaImages : null);
  const variantAssignments = Array.isArray(options.variantImages)
    ? normalizeVariantImageAssignments(options.variantImages)
    : normalizeVariantImageAssignments(previous?.result?.variantImages);
  const identifier = String(publication.wp_post_id ?? publication.style_no);
  // WordPress media comes in through the import itself; 1688 detail images (not
  // part of the WordPress set) are downloaded to the collector on demand and
  // passed to the portal as extra media URLs.
  const wpImageSet = new Set((Array.isArray(publication.payload?.images) ? publication.payload.images : [])
    .map((image) => normalizedImageUrl(image?.url)).filter(Boolean));
  let chosenList = Array.isArray(chosenImages)
    ? chosenImages.map((entry) => ({ url: String(entry?.url ?? '').trim(), visible: entry?.visible !== false }))
      .filter((entry) => entry.url)
    : null;
  // A colour image assigned to a variant must be part of the published gallery —
  // the portal only offers published images in the variant picker — so assigned
  // images are auto-included and marked visible.
  if (variantAssignments.length) {
    if (chosenList) {
      const chosenByUrl = new Map(chosenList.map((entry) => [entry.url, entry]));
      for (const assignment of variantAssignments) {
        const existing = chosenByUrl.get(assignment.url);
        if (existing) existing.visible = true;
        else chosenList.push({ url: assignment.url, visible: true });
      }
    } else {
      chosenList = variantAssignments.map((assignment) => ({ url: assignment.url, visible: true }));
    }
  }
  const remoteDetailUrls = (chosenList ?? []).filter((entry) => entry.visible
    && !wpImageSet.has(normalizedImageUrl(entry.url))
    && /^https?:\/\//i.test(entry.url)
    && !entry.url.startsWith(config.publicBaseUrl)).map((entry) => entry.url);
  let detailForImages = detail;
  if (remoteDetailUrls.length) {
    await ensureDescriptionImages(detail, remoteDetailUrls).catch(() => {});
    detailForImages = await db.getProductDetail(productDetailId).catch(() => detail);
  }
  const storedDetailByUrl = new Map();
  for (const image of (detailForImages?.images ?? []).filter((item) => item.image_type === 'description')) {
    const publicPath = imagePublicPath(image.storage_path);
    if (publicPath) storedDetailByUrl.set(normalizedImageUrl(image.source_url), `${config.publicBaseUrl}${publicPath}`);
  }
  const finalUrlByInput = new Map();
  const finalImages = (chosenList ?? []).map((entry) => {
    const normalized = normalizedImageUrl(entry.url);
    if (wpImageSet.has(normalized)) {
      finalUrlByInput.set(entry.url, entry.url);
      return { url: entry.url, visible: entry.visible, kind: 'wp' };
    }
    const stored = storedDetailByUrl.get(normalized);
    const url = stored ?? (/^\//.test(entry.url) ? `${config.publicBaseUrl}${entry.url}` : entry.url);
    finalUrlByInput.set(entry.url, url);
    return { url, visible: entry.visible, kind: 'detail' };
  });
  // A downloaded detail image can reuse an already stored file URL; the same URL
  // must only appear once, with visible winning over hidden.
  const mergedImages = [];
  const mergedByUrl = new Map();
  for (const entry of finalImages) {
    const existing = mergedByUrl.get(entry.url);
    if (existing) {
      if (entry.visible) existing.visible = true;
      if (entry.kind === 'wp') existing.kind = 'wp';
      continue;
    }
    const copy = { ...entry };
    mergedByUrl.set(entry.url, copy);
    mergedImages.push(copy);
  }
  // Assignments resolved to their final published URLs (detail images can be
  // re-stored under a different public URL during the publish) and forced visible.
  const resolvedVariantImages = variantAssignments.map((assignment) => ({
    color: assignment.color,
    url: finalUrlByInput.get(assignment.url) ?? assignment.url,
  }));
  const variantUrlSet = new Set(resolvedVariantImages.map((entry) => entry.url));
  if (variantUrlSet.size) {
    for (const entry of mergedImages) {
      if (variantUrlSet.has(entry.url)) entry.visible = true;
    }
  }
  const detailMediaUrls = [...new Set(mergedImages.filter((entry) => entry.kind === 'detail' && entry.visible).map((entry) => entry.url))];
  try {
    const product = await importWordPressProductToPortal(identifier, portal, { mediaUrls: detailMediaUrls });
    let media = null;
    if (mergedImages.length && product?.id) {
      media = await updatePortalCatalogMedia(portal, product.id, product, mergedImages);
    }
    let variantMatch = null;
    if (resolvedVariantImages.length && product?.id) {
      variantMatch = await applyPortalVariantImages(portal, product, resolvedVariantImages, productDetailId);
    }
    const portalBase = portal.url.replace(/\/$/, '');
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
        mediaImages: mergedImages ?? null,
        variantImages: resolvedVariantImages.length ? resolvedVariantImages : null,
        variantMatch: variantMatch ? {
          colors: variantMatch.colors.length,
          variants: variantMatch.variants,
          unmatchedColors: variantMatch.unmatchedColors,
        } : null,
        target,
      } : { target },
      lastError: null,
    });
    return { product, publication: saved, media, target, images: mergedImages, variantImages: resolvedVariantImages, variantMatch };
  } catch (error) {
    const message = String(error?.message || error);
    await db.failPortalPublication(productDetailId, message, {
      wpPostId: publication.wp_post_id ?? null,
      styleNo: publication.style_no ?? null,
    }).catch(() => {});
    throw error;
  }
}

app.post('/api/portal/publish', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const productDetailId = Number(request.body?.productDetailId);
  if (!Number.isInteger(productDetailId) || productDetailId <= 0) {
    return reply.code(400).send({ error: 'product_detail_id_required' });
  }
  try {
    const result = await publishProductToPortal(productDetailId, {
      images: Array.isArray(request.body?.images) ? request.body.images : null,
      variantImages: Array.isArray(request.body?.variantImages) ? request.body.variantImages : null,
      target: request.body?.target === 'staging' ? 'staging' : 'production',
    });
    return {
      status: 'synced', productDetailId,
      portalProduct: result.product, publication: result.publication, media: result.media,
      variantImages: result.variantImages ?? null, variantMatch: result.variantMatch ?? null,
    };
  } catch (error) {
    const status = Number(error?.status) || 502;
    return reply.code(status).send({ error: error?.code || 'portal_publish_failed', message: String(error?.message || error) });
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
  const [record, detail] = await Promise.all([db.getProductSplitPlan(id), db.getProductDetail(id)]);
  // Every stored image (any type) with a local thumbnail, so the split panel can
  // render assigned/deduped strips without a request per image.
  const images = (detail?.images ?? []).map((image) => {
    const base = imagePublicPath(image.storage_path);
    const source = /^https?:\/\//i.test(String(image.source_url || '')) ? String(image.source_url) : null;
    return { id: String(image.id), type: image.image_type, thumb: base ? `${base}?w=96` : source };
  });
  // The pre-assignment pool: every image the split analysis could see — stored
  // images (thumbnails served locally) plus detail-page URLs that were never
  // downloaded (rendered from the CDN, fetched only when actually used).
  const pool = [];
  const poolSeen = new Set();
  for (const image of detail?.images ?? []) {
    if (image.image_type === 'sku') continue;
    const key = normalizedSourceImageKey(image.source_url) || `id:${image.id}`;
    if (poolSeen.has(key)) continue;
    poolSeen.add(key);
    const base = imagePublicPath(image.storage_path);
    const source = /^https?:\/\//i.test(String(image.source_url || '')) ? String(image.source_url) : null;
    pool.push({
      id: String(image.id), url: source, type: image.image_type,
      thumb: base ? `${base}?w=96` : source,
    });
  }
  for (const match of String(detail?.raw_data?.linkfox?.raw?.description ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    let url = match[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https:\/\//i.test(url)) continue;
    const key = normalizedSourceImageKey(url);
    if (!key || poolSeen.has(key)) continue;
    poolSeen.add(key);
    pool.push({ id: null, url, type: 'description-web', thumb: url });
  }
  return { productDetailId: id, plan: record?.plan ?? null, updatedAt: record?.updated_at ?? null, images, pool };
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

// Download swatch images that exist as source URLs but were never stored
// locally, so every variant can fall back to its own image during
// normalization. Bounded and failure-tolerant.
const SKU_SWATCH_DOWNLOAD_LIMIT = 80;

async function ensureSkuSwatchImages(detail) {
  const raw = detail?.raw_data ?? {};
  const options = (Array.isArray(raw.skuOptions) ? raw.skuOptions : [])
    .filter((option) => /(颜色|color|colour)/i.test(String(option?.dimensionName ?? '')));
  const stored = new Set((detail?.images ?? [])
    .filter((image) => image.image_type === 'sku')
    .map((image) => normalizedImageUrl(image.source_url)));
  const missing = options.filter((option) => {
    const url = String(option?.image ?? '').trim();
    return /^https:\/\//i.test(url) && !stored.has(normalizedImageUrl(url));
  }).slice(0, SKU_SWATCH_DOWNLOAD_LIMIT);
  if (!missing.length) return { downloaded: 0, failed: 0 };
  const root = path.resolve(config.storagePath, 'product-images');
  const folder = path.resolve(root, String(detail.offer_id ?? ''));
  if (!folder.startsWith(`${root}${path.sep}`)) return { downloaded: 0, failed: 0 };
  await fs.mkdir(folder, { recursive: true });
  const results = { downloaded: 0, failed: 0 };
  let next = 0;
  const workers = Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= missing.length) return;
      const url = String(missing[index].image);
      try {
        const response = await fetch(url, {
          headers: { referer: 'https://detail.1688.com/', 'user-agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 64) throw new Error('image too small');
        const extension = (url.split('?')[0].match(/\.(jpe?g|png|webp|gif|avif)$/i) || ['.jpg'])[0].toLowerCase();
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        const fileName = `sku-${String(index + 1).padStart(4, '0')}-${sha.slice(0, 12)}${extension}`;
        const filePath = path.join(folder, fileName);
        await fs.writeFile(filePath, bytes);
        await db.addProductImage(detail.id, {
          type: 'sku', sortOrder: 1000 + index, sourceUrl: url, storagePath: filePath,
          mimeType: String(response.headers.get('content-type') || '').split(';')[0] || 'image/jpeg',
          contentSha256: sha, byteSize: bytes.length,
        });
        results.downloaded += 1;
      } catch {
        results.failed += 1;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Compose each variant's SKU from the normalized code + size: {STYLE}-{CODE}-{SIZE}
// (published products carry their real style number; others get the suffix now
// and are prefixed after the style number is allocated at publish time).
function composeVariantSkus(detail, normalizationRecord, styleNo) {
  const result = normalizationRecord?.result ?? normalizationRecord ?? null;
  if (!result) return null;
  const colourCode = new Map((result.colours ?? []).map((colour) => [String(colour.source ?? ''), colour.code || null]));
  const sizeText = new Map((result.sizes ?? []).map((size) => [String(size.source ?? ''), size.text || size.source]));
  const used = new Map();
  const rows = [];
  for (const row of detail.skus ?? []) {
    const options = row.option_data ?? {};
    const colourSource = options.Color ?? options['颜色'] ?? null;
    const sizeSource = options.Size ?? options['尺码'] ?? null;
    const code = colourSource ? (colourCode.get(String(colourSource)) ?? null) : null;
    const size = sizeSource ? (sizeText.get(String(sizeSource)) ?? String(sizeSource)) : null;
    const segments = [code, size]
      .filter(Boolean)
      .map((value) => String(value).toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
      .filter(Boolean);
    if (!segments.length) continue;
    const suffix = segments.join('-');
    let sku = styleNo ? `${styleNo}-${suffix}` : suffix;
    const count = (used.get(sku) ?? 0) + 1;
    used.set(sku, count);
    if (count > 1) sku = `${sku}-${count}`;
    rows.push({
      skuKey: row.sku_key,
      skuId: row.sku_id ?? null,
      sku,
      colour: colourSource,
      code,
      size: sizeSource,
      sizeText: size,
      price: row.price === null ? null : Number(row.price),
      stock: row.stock === null ? null : Number(row.stock),
      pendingStyleNumber: !styleNo,
    });
  }
  return rows;
}

async function saveComposedSkus(detail, normalizationRecord, styleNo) {
  const rows = composeVariantSkus(detail, normalizationRecord, styleNo);
  if (!rows || !rows.length) return null;
  await db.updateSkuVariantSkus(detail.id, rows);
  const result = {
    ...(normalizationRecord.result ?? {}),
    variantSkus: rows,
    styleNo: styleNo ?? null,
    skusUpdatedAt: new Date().toISOString(),
  };
  await db.saveVariantNormalization(detail.id, result, normalizationRecord.model ?? null);
  return { rows, result };
}

// Recompute the composed variant SKUs for a product from its stored
// normalization (also refreshes the SKU table rows).
app.post('/api/product-details/:id/compose-skus', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const normalization = await db.getVariantNormalization(id);
  if (!normalization) return reply.code(409).send({ error: 'normalization_required' });
  const publication = await db.getWordPressPublication(id);
  const styleNo = publication?.style_no ?? null;
  const composed = await saveComposedSkus(detail, normalization, styleNo);
  if (!composed) return reply.code(422).send({ error: 'no_sku_rows' });
  return {
    productDetailId: id, styleNo, pendingStyleNumber: !styleNo,
    count: composed.rows.length, rows: composed.rows,
  };
});

// Content generation for the split products of a bundle: one vision call per
// split product (title, description, variant names/codes, sizes) plus the
// composed {STYLE}S{n}-{CODE}-{SIZE} SKUs. Runs as a background job (up to six
// model calls per bundle); nothing is published.
const splitContentJobs = new Map();

app.post('/api/product-details/:id/split-content', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const running = [...splitContentJobs.values()].filter((job) => job.status === 'running').length;
  if (running >= 4) {
    return reply.code(409).send({ error: 'split_content_busy', running });
  }
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const planRecord = await db.getProductSplitPlan(id);
  if (!planRecord?.plan?.products?.length) {
    return reply.code(409).send({ error: 'split_plan_required' });
  }
  const publication = await db.getWordPressPublication(id);
  const job = {
    id: crypto.randomUUID(), productDetailId: id, status: 'running',
    startedAt: new Date().toISOString(), completedAt: null, error: null, productCount: 0,
  };
  splitContentJobs.set(job.id, job);
  trimTerminalJobs(splitContentJobs);
  (async () => {
    try {
      const prior = await db.getSplitContents(id);
      const { contents } = await generateSplitContents({
        detail,
        plan: planRecord.plan,
        styleNo: publication?.style_no ?? null,
        config: {
          apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
          model: config.complexModel, reasoningEffort: config.reasoningEffort,
        },
        baseUrl: config.publicBaseUrl,
      });
      // Already published split products keep their WordPress results
      // (reserved style numbers, post ids) across content regenerations.
      const priorWp = new Map((prior?.result?.products ?? [])
        .map((product) => [String(product.id), product.wp])
        .filter(([, wp]) => wp));
      for (const product of contents.products) {
        const wp = priorWp.get(String(product.id));
        if (wp) product.wp = wp;
      }
      // The review-saved publish order survives content regenerations; ids
      // that no longer exist are simply ignored when the order is applied.
      const priorOrder = new Map((prior?.result?.products ?? [])
        .map((product) => [String(product.id), product.publishOrder])
        .filter(([, order]) => Array.isArray(order) && order.length));
      for (const product of contents.products) {
        const order = priorOrder.get(String(product.id));
        if (order) product.publishOrder = order;
      }
      // Review-picked swatch images survive content regenerations as well.
      const priorSwatch = new Map();
      for (const product of prior?.result?.products ?? []) {
        for (const colour of product.colours ?? []) {
          if (colour?.swatchImageId) priorSwatch.set(String(product.id) + '|' + String(colour.source ?? ''), colour.swatchImageId);
        }
      }
      for (const product of contents.products) {
        for (const colour of product.colours ?? []) {
          const picked = priorSwatch.get(String(product.id) + '|' + String(colour.source ?? ''));
          if (picked) colour.swatchImageId = picked;
        }
      }
      // Manual publish-image additions/removals survive regenerations too.
      const priorOverrides = new Map((prior?.result?.products ?? [])
        .map((product) => [String(product.id), {
          added: Array.isArray(product.publishAdded) ? product.publishAdded : null,
          excluded: Array.isArray(product.publishExcluded) ? product.publishExcluded : null,
        }]));
      for (const product of contents.products) {
        const overrides = priorOverrides.get(String(product.id));
        if (overrides?.added?.length) product.publishAdded = overrides.added;
        if (overrides?.excluded?.length) product.publishExcluded = overrides.excluded;
      }
      const saved = await db.saveSplitContents(id, contents, config.complexModel ?? null);
      job.productCount = contents.products.length;
      job.result = { productCount: contents.products.length, styleNo: contents.styleNo };
      job.updatedAt = saved.updated_at;
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 300);
      app.log.error({ err: error, productDetailId: id }, 'split content generation failed');
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/split-content-jobs/:id', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const job = splitContentJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

app.get('/api/product-details/:id/split-content', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const record = await db.getSplitContents(id);
  // Live publish-set preview: resolve each split product's stored refs and run
  // the exact publisher dedupe, so the review UI shows the final WP image set
  // instead of the generation-time refs (which repair jobs can rewrite).
  const publishSets = {};
  const products = Array.isArray(record?.result?.products) ? record.result.products : [];
  if (products.length) {
    const detail = await db.getProductDetail(id);
    for (const product of products) {
      const resolvedRows = resolvePublishImageRows(detail, product?.imageRefs ?? {});
      const outcome = await computePublishImageRows(detail, product);
      publishSets[String(product?.id ?? '')] = {
        candidateCount: resolvedRows.length,
        imageIds: outcome.rows.map((row) => String(row.id)),
        savedOrder: Array.isArray(product?.publishOrder) ? product.publishOrder.map(String) : [],
        addedCount: Array.isArray(product?.publishAdded) ? product.publishAdded.length : 0,
        excludedCount: Array.isArray(product?.publishExcluded) ? product.publishExcluded.length : 0,
        removed: (outcome.removed ?? []).map((entry) => ({
          imageId: String(entry.imageId),
          keptImageId: entry.keptImageId ? String(entry.keptImageId) : null,
          reason: entry.reason ?? 'hash',
        })),
      };
    }
  }
  return {
    productDetailId: id,
    result: record?.result ?? null,
    model: record?.model ?? null,
    updatedAt: record?.updated_at ?? null,
    publishSets,
  };
});

// Review-panel edits that must reach the live pages: publish image order and
// colour swatches. Saving either one re-syncs the bundle to WordPress
// (existing attachments are reused) and tracks the sync as a pollable job.
const splitOrderJobs = new Map();

/** Re-sync a bundle's split products to WordPress and track the job. Sync jobs
 * for the same detail run strictly one after another (last save wins). */
const splitSyncChains = new Map();

async function queueSplitSyncJob({ productDetailId, productId, detail, publication, contents, trigger }) {
  const planRecord = await db.getProductSplitPlan(productDetailId).catch(() => null);
  const job = {
    id: crypto.randomUUID(), productDetailId, productId, status: 'queued',
    startedAt: new Date().toISOString(), completedAt: null, error: null,
  };
  splitOrderJobs.set(job.id, job);
  trimTerminalJobs(splitOrderJobs);
  const chainKey = String(productDetailId);
  const previous = splitSyncChains.get(chainKey) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    job.status = 'running';
    try {
      await syncSplitBundle({
        productDetailId, detail, publication, contents, plan: planRecord?.plan ?? null,
      });
      await scheduleProductRagSync(productDetailId, { trigger }).catch(() => {});
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 300);
    } finally {
      job.completedAt = new Date().toISOString();
    }
  });
  splitSyncChains.set(chainKey, run);
  run.then(() => {
    if (splitSyncChains.get(chainKey) === run) splitSyncChains.delete(chainKey);
  });
  return job;
}

/** Resolve review-submitted image refs (stored ids or source URLs) to image ids. */
function resolveReviewImageRefs(detail, refs) {
  const images = detail?.images ?? [];
  const byId = new Map(images.map((image) => [String(image.id), image]));
  const byUrl = new Map();
  for (const image of images) {
    const key = normalizedSourceImageKey(image.source_url);
    if (key && !byUrl.has(key)) byUrl.set(key, image);
  }
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const value = String(ref ?? '');
    if (!value) continue;
    const image = byId.get(value) ?? byUrl.get(normalizedSourceImageKey(value)) ?? null;
    if (!image) continue;
    const key = String(image.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// Save the review-edited publish image set (manual additions from the assigned
// images, removals, order) and re-sync WordPress so the live pages follow.
app.put('/api/product-details/:id/split-publish-images', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const productId = String(request.body?.productId ?? '');
  const refs = (Array.isArray(request.body?.imageIds) ? request.body.imageIds : [])
    .map((value) => String(value)).filter(Boolean);
  if (!productId || !refs.length) return reply.code(400).send({ error: 'image_ids_required' });
  const record = await db.getSplitContents(id);
  const product = (record?.result?.products ?? []).find((item) => String(item?.id) === productId);
  if (!product) return reply.code(404).send({ error: 'split_product_not_found' });
  let detail = await db.getProductDetail(id);
  // URL-only assigned images may not be stored locally yet; fetch them so an
  // added image can actually be published instead of silently disappearing.
  const unresolved = refs.filter((ref) => /^https:\/\//i.test(ref) && !resolveReviewImageRefs(detail, [ref]).length);
  let downloaded = 0;
  if (unresolved.length) {
    const result = await downloadDetailImageUrls(detail, unresolved).catch(() => ({ downloaded: 0 }));
    downloaded = result.downloaded ?? 0;
    if (downloaded) detail = await db.getProductDetail(id);
  }
  const desired = resolveReviewImageRefs(detail, refs);
  const skipped = refs.filter((ref) => !resolveReviewImageRefs(detail, [ref]).length);
  if (!desired.length) return reply.code(400).send({ error: 'no_valid_image_ids', skipped });
  // Refs → stored ids + local thumbnails, so the review UI can patch freshly
  // downloaded images in place instead of reloading the whole panel.
  const resolved = [];
  for (const ref of refs) {
    const ids = resolveReviewImageRefs(detail, [ref]);
    const image = ids.length ? (detail?.images ?? []).find((item) => String(item.id) === ids[0]) : null;
    if (!image) continue;
    const base = imagePublicPath(image.storage_path);
    const source = /^https?:\/\//i.test(String(image.source_url || '')) ? String(image.source_url) : null;
    resolved.push({ ref: String(ref), id: String(image.id), thumb: base ? `${base}?w=96` : source });
  }
  // Reconcile the manual overrides against the automatic (deduped) base set.
  const base = (await dedupePublishImageRows(resolvePublishImageRows(detail, product.imageRefs ?? {}))).rows;
  const baseIds = new Set(base.map((row) => String(row.id)));
  const desiredSet = new Set(desired);
  const excluded = new Set((Array.isArray(product.publishExcluded) ? product.publishExcluded : []).map((value) => String(value)));
  const added = new Set((Array.isArray(product.publishAdded) ? product.publishAdded : []).map((value) => String(value)));
  for (const imageId of desired) {
    excluded.delete(imageId); // re-added images stop being excluded
    if (!baseIds.has(imageId)) added.add(imageId); // images outside the base set are manual additions
  }
  for (const rowId of baseIds) {
    if (!desiredSet.has(rowId)) excluded.add(rowId); // removed from the publish set
  }
  for (const imageId of [...added]) {
    if (!desiredSet.has(imageId)) added.delete(imageId); // added images removed again
  }
  product.publishOrder = desired;
  product.publishAdded = [...added];
  product.publishExcluded = [...excluded];
  await db.saveSplitContents(id, record.result, record.model ?? null);
  // Report images that resolve but will still be folded away by the publish
  // duplicate guard (exact / same-URL copies of what is already published).
  const outcome = await computePublishImageRows(detail, product);
  const keptIds = new Set(outcome.rows.map((row) => String(row.id)));
  const duplicates = desired.filter((value) => !keptIds.has(value));

  const publication = await db.getWordPressPublication(id);
  const isPublished = (record.result.products ?? []).some((item) => item?.wp?.postId);
  if (!publication?.payload || !isPublished) {
    return { saved: true, sync: null, reason: 'not_published', downloaded, skipped, duplicates, resolved };
  }
  const job = await queueSplitSyncJob({
    productDetailId: id, productId, detail, publication,
    contents: record.result, trigger: 'wordpress_publish_images',
  });
  return { saved: true, sync: { jobId: job.id }, downloaded, skipped, duplicates, resolved };
});

// Set (imageId) or clear (null) the WordPress colour-swatch image for one
// colour option, choosing among the stored product images; the bundle is
// re-synced so the live swatch follows.
app.put('/api/product-details/:id/split-swatch', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const productId = String(request.body?.productId ?? '');
  const colourSource = String(request.body?.colourSource ?? '');
  const imageId = request.body?.imageId === null || request.body?.imageId === undefined
    ? null : String(request.body.imageId);
  if (!productId || !colourSource) return reply.code(400).send({ error: 'product_and_colour_required' });
  const record = await db.getSplitContents(id);
  const product = (record?.result?.products ?? []).find((item) => String(item?.id) === productId);
  if (!product) return reply.code(404).send({ error: 'split_product_not_found' });
  const colour = (product.colours ?? []).find((item) => String(item?.source ?? '') === colourSource);
  if (!colour) return reply.code(404).send({ error: 'colour_not_found' });
  let detail = await db.getProductDetail(id);
  let swatchResolved = null;
  if (imageId !== null) {
    let resolved = resolveReviewImageRefs(detail, [imageId]);
    if (!resolved.length && /^https:\/\//i.test(imageId)) {
      // Not stored locally yet: fetch it now so it can actually be the swatch.
      await downloadDetailImageUrls(detail, [imageId]).catch(() => null);
      detail = await db.getProductDetail(id);
      resolved = resolveReviewImageRefs(detail, [imageId]);
    }
    const resolvedId = resolved[0] ?? null;
    if (!resolvedId) return reply.code(400).send({ error: 'image_not_found' });
    const image = (detail?.images ?? []).find((item) => String(item.id) === resolvedId);
    if (!image || (!image.source_url && !image.storage_path)) return reply.code(400).send({ error: 'image_has_no_source' });
    colour.swatchImageId = resolvedId;
    const base = imagePublicPath(image.storage_path);
    const source = /^https?:\/\//i.test(String(image.source_url || '')) ? String(image.source_url) : null;
    swatchResolved = { id: resolvedId, thumb: base ? `${base}?w=96` : source };
  } else {
    delete colour.swatchImageId;
  }
  await db.saveSplitContents(id, record.result, record.model ?? null);

  const publication = await db.getWordPressPublication(id);
  const isPublished = (record.result.products ?? []).some((item) => item?.wp?.postId);
  if (!publication?.payload || !isPublished) {
    return { saved: true, sync: null, reason: 'not_published', resolved: swatchResolved };
  }
  const job = await queueSplitSyncJob({
    productDetailId: id, productId, detail, publication,
    contents: record.result, trigger: 'wordpress_swatch',
  });
  return { saved: true, sync: { jobId: job.id }, resolved: swatchResolved };
});

app.get('/api/split-order-jobs/:id', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  return splitOrderJobs.get(request.params.id) ?? reply.code(404).send({ error: 'not_found' });
});

// Re-run ONLY the variant normalization for every split product (keeps the
// generated titles/descriptions, refreshes swatch text/code/image, sizes and
// the composed SKUs). Background job, up to four concurrent.
const splitNormalizeJobs = new Map();

app.post('/api/product-details/:id/split-normalize', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const running = [...splitNormalizeJobs.values()].filter((job) => job.status === 'running').length;
  if (running >= 4) return reply.code(409).send({ error: 'split_normalize_busy', running });
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const planRecord = await db.getProductSplitPlan(id);
  if (!planRecord?.plan?.products?.length) return reply.code(409).send({ error: 'split_plan_required' });
  const contentRecord = await db.getSplitContents(id);
  if (!contentRecord?.result?.products?.length) return reply.code(409).send({ error: 'split_content_required' });
  const publication = await db.getWordPressPublication(id);
  const job = {
    id: crypto.randomUUID(), productDetailId: id, status: 'running',
    startedAt: new Date().toISOString(), completedAt: null, error: null, productCount: 0,
  };
  splitNormalizeJobs.set(job.id, job);
  trimTerminalJobs(splitNormalizeJobs);
  (async () => {
    try {
      const contents = await normalizeSplitContents({
        detail,
        plan: planRecord.plan,
        contents: contentRecord.result,
        styleNo: publication?.style_no ?? null,
        config: {
          apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
          model: config.complexModel, reasoningEffort: config.reasoningEffort,
        },
        baseUrl: config.publicBaseUrl,
      });
      const saved = await db.saveSplitContents(id, contents, config.complexModel ?? null);
      job.productCount = contents.products.length;
      job.status = 'completed';
      job.updatedAt = saved.updated_at;
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 300);
      request.log.error({ err: error, productDetailId: id }, 'split variant normalization failed');
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/split-normalize-jobs/:id', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const job = splitNormalizeJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// Image deduplication for publishing: hash-based (exact + near) with an
// optional vision-model review. Nothing is deleted from storage; the result is
// stored in raw_data.imageDedupe and applied when the WordPress payload is
// built (and shown in the publish preview).
app.post('/api/product-details/:id/image-dedupe', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const mode = request.body?.mode === 'hash' ? 'hash' : 'hash+llm';
  const candidates = (detail.images ?? [])
    .filter((image) => image.image_type === 'main' || image.image_type === 'gallery')
    .sort((left, right) => (left.image_type !== right.image_type
      ? (left.image_type === 'main' ? -1 : 1) : Number(left.sort_order) - Number(right.sort_order)))
    .map((image) => {
      const sourceUrl = /^https:\/\//i.test(image.source_url || '') ? String(image.source_url) : null;
      const base = imagePublicPath(image.storage_path);
      return {
        id: String(image.id), type: image.image_type, sortOrder: Number(image.sort_order) || 0,
        sourceUrl: image.source_url ?? null, storagePath: image.storage_path ?? null,
        contentSha256: image.content_sha256 ?? null,
        url: sourceUrl || (base ? `${config.publicBaseUrl}${base}` : null),
      };
    });
  const hashResult = await dedupeImagesByHash(candidates);
  let llm = { removed: [], skipped: true };
  if (mode === 'hash+llm') {
    try {
      llm = await dedupeImagesWithLlm({
        images: hashResult.kept, title: detail.title ?? '',
        config: {
          apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
          model: config.complexModel, reasoningEffort: config.reasoningEffort,
        },
      });
    } catch (error) {
      request.log.warn({ err: error, productDetailId: id }, 'LLM image dedupe pass failed');
      llm = { removed: [], error: String(error?.message || error).slice(0, 200) };
    }
  }
  const removed = [...hashResult.removed, ...(llm.removed ?? [])];
  const result = {
    version: 1,
    mode,
    model: config.complexModel ?? null,
    total: candidates.length,
    keptIds: hashResult.kept.filter((image) => !(llm.removed ?? []).some((entry) => entry.imageId === String(image.id)))
      .map((image) => String(image.id)),
    removed,
    counts: {
      exact: hashResult.removed.filter((entry) => entry.reason === 'exact').length,
      near: hashResult.removed.filter((entry) => entry.reason === 'near').length,
      llm: (llm.removed ?? []).length,
    },
    updatedAt: new Date().toISOString(),
  };
  await db.updateProductRawData(id, { imageDedupe: result });
  return { productDetailId: id, ...result };
});

app.get('/api/product-details/:id/image-dedupe', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  return { productDetailId: id, result: detail.raw_data?.imageDedupe ?? null };
});

// Download the detail (description) images that only exist as URLs (LinkFox
// description HTML) into local storage so they can be published. Bounded and
// failure-tolerant; existing local rows are skipped.
const DESCRIPTION_IMAGE_LIMIT = 60;

async function ensureDescriptionImages(detail, assignedUrls = null) {
  const raw = detail?.raw_data ?? {};
  const stored = new Set((detail?.images ?? [])
    .filter((image) => image.image_type === 'description')
    .map((image) => normalizedImageUrl(image.source_url)));
  const allowed = assignedUrls ? new Set(assignedUrls.map((url) => normalizedImageUrl(url))) : null;
  const urls = [];
  const seen = new Set();
  for (const match of String(raw?.linkfox?.raw?.description ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    let url = match[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https:\/\//i.test(url)) continue;
    const key = normalizedImageUrl(url);
    if (stored.has(key) || seen.has(key)) continue;
    if (allowed && !allowed.has(key)) continue; // only images assigned to split products
    seen.add(key);
    urls.push(url);
    if (urls.length >= DESCRIPTION_IMAGE_LIMIT) break;
  }
  for (const image of (detail?.images ?? []).filter((item) => item.image_type === 'description')) {
    const key = normalizedImageUrl(image.source_url);
    if (seen.has(key)) continue;
    seen.add(key);
  }
  if (!urls.length) return { downloaded: 0, failed: 0 };
  const root = path.resolve(config.storagePath, 'product-images');
  const folder = path.resolve(root, String(detail.offer_id ?? ''));
  if (!folder.startsWith(`${root}${path.sep}`)) return { downloaded: 0, failed: 0 };
  await fs.mkdir(folder, { recursive: true });
  const results = { downloaded: 0, failed: 0 };
  let next = 0;
  const workers = Array.from({ length: Math.min(5, urls.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= urls.length) return;
      const url = urls[index];
      try {
        const response = await fetch(url, {
          headers: { referer: 'https://detail.1688.com/', 'user-agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 64) throw new Error('image too small');
        const extension = (url.split('?')[0].match(/\.(jpe?g|png|webp|gif|avif)$/i) || ['.jpg'])[0].toLowerCase();
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        const fileName = `description-${String(index + 1).padStart(4, '0')}-${sha.slice(0, 12)}${extension}`;
        const filePath = path.join(folder, fileName);
        await fs.writeFile(filePath, bytes);
        await db.addProductImage(detail.id, {
          type: 'description', sortOrder: index, sourceUrl: url, storagePath: filePath,
          mimeType: String(response.headers.get('content-type') || '').split(';')[0] || 'image/jpeg',
          contentSha256: sha, byteSize: bytes.length,
        });
        results.downloaded += 1;
      } catch {
        results.failed += 1;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Download explicit image URLs (e.g. an assigned image the review wants to
// publish but that was never stored locally) into the product's media folder.
async function downloadDetailImageUrls(detail, urls) {
  const results = { downloaded: 0, failed: 0 };
  const root = path.resolve(config.storagePath, 'product-images');
  const folder = path.resolve(root, String(detail.offer_id ?? ''));
  if (!folder.startsWith(`${root}${path.sep}`)) return results;
  await fs.mkdir(folder, { recursive: true });
  for (const [index, url] of urls.entries()) {
    try {
      const response = await fetch(url, {
        headers: { referer: 'https://detail.1688.com/', 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 64) throw new Error('image too small');
      const extension = (url.split('?')[0].match(/\.(jpe?g|png|webp|gif|avif)$/i) || ['.jpg'])[0].toLowerCase();
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      const fileName = `detail-extra-${sha.slice(0, 16)}${extension}`;
      const filePath = path.join(folder, fileName);
      await fs.writeFile(filePath, bytes);
      await db.addProductImage(detail.id, {
        type: 'description', sortOrder: 500 + index, sourceUrl: url, storagePath: filePath,
        mimeType: String(response.headers.get('content-type') || '').split(';')[0] || 'image/jpeg',
        contentSha256: sha, byteSize: bytes.length,
      });
      results.downloaded += 1;
    } catch {
      results.failed += 1;
    }
  }
  return results;
}

// Variant normalization: the model proposes a swatch text/code/image for every
// existing colour option plus standardized size labels; the server validates
// the one-to-one mapping and stores the result for the publisher and the UI.
app.post('/api/product-details/:id/normalize-variants', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  try {
    // Make sure every colour option that has a source swatch image actually has
    // a local copy, so the normalizer can always fall back to it.
    const ensured = await ensureSkuSwatchImages(detail).catch(() => ({ downloaded: 0, failed: 0 }));
    const freshDetail = ensured.downloaded ? await db.getProductDetail(id) : detail;
    const { result, input } = await normalizeVariants({
      detail: freshDetail,
      config: {
        apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
        model: config.complexModel, reasoningEffort: config.reasoningEffort,
      },
      baseUrl: config.publicBaseUrl,
    });
    const saved = await db.saveVariantNormalization(id, result, config.complexModel ?? null);
    const publication = await db.getWordPressPublication(id);
    const composed = await saveComposedSkus(await db.getProductDetail(id), saved, publication?.style_no ?? null);
    return {
      productDetailId: id,
      result: composed?.result ?? saved.result,
      model: saved.model,
      updatedAt: saved.updated_at,
      imageCount: input.images.length,
      swatchImagesDownloaded: ensured.downloaded,
      variantSkuCount: composed?.rows.length ?? 0,
      styleNo: publication?.style_no ?? null,
      pendingStyleNumber: !publication?.style_no,
    };
  } catch (error) {
    request.log.error({ err: error, productDetailId: id }, 'variant normalization failed');
    return reply.code(502).send({
      error: 'variant_normalization_failed', message: String(error?.message || error).slice(0, 300),
    });
  }
});

app.get('/api/product-details/:id/variant-normalization', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const record = await db.getVariantNormalization(id);
  const detail = record ? await db.getProductDetail(id) : null;
  return {
    productDetailId: id,
    result: record ? decorateNormalization(record.result, detail) : null,
    model: record?.model ?? null,
    updatedAt: record?.updated_at ?? null,
  };
});

/** Add local thumbnails to a stored normalization for the review UI. */
function decorateNormalization(result, detail) {
  if (!result) return result;
  const images = new Map((detail?.images ?? []).map((image) => [String(image.id), image]));
  return {
    ...result,
    colours: (Array.isArray(result.colours) ? result.colours : []).map((colour) => {
      const image = colour.imageId ? images.get(String(colour.imageId)) : null;
      const base = image ? imagePublicPath(image.storage_path) : null;
      return { ...colour, thumb: base ? `${base}?w=96` : (image?.source_url ?? null) };
    }),
  };
}
// Pre-publish review layer: everything the publisher would use for this
// capture, assembled from stored data without any model call. Mirrors the
// translation, pricing, merchandising, images, variants and every publish gate.
app.get('/api/product-details/:id/publish-preview', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const [translation, publication, sourceListings, normalization] = await Promise.all([
    db.getLatestProductTranslation(id, 'en'),
    db.getWordPressPublication(id),
    db.listShopProductSources(detail.offer_id),
    db.getVariantNormalization(id),
  ]);
  const policy = evaluateShopProductPolicy(sourceListings);
  let pricing = null;
  try { pricing = buildWearHongxiuPricing(detail); } catch { pricing = null; }
  const raw = detail.raw_data ?? {};
  const priceInfo = raw.price ?? {};
  const skuRows = detail.skus ?? [];
  const sourcePrices = skuRows.map((row) => Number(row.price)).filter((value) => Number.isFinite(value) && value > 0);
  const skuPriceMax = sourcePrices.length ? Math.max(...sourcePrices) : null;
  const stockKnown = skuRows.length > 0 && skuRows.every((row) => row.stock !== null && Number(row.stock) >= 0);
  const allInStock = skuRows.length > 0 && skuRows.every((row) => row.stock !== null && Number(row.stock) > 0);

  // Swatch mapping: colour option text -> local thumbnail when the source URL
  // matches a stored SKU image (same rule the publisher uses).
  const normalizeImageKey = (value) => String(value ?? '').trim()
    .replace(/^http:/i, 'https:').replace(/[?#].*$/, '').replace(/_\.webp$/i, '')
    .replace(/_\d+x\d+[^/]*$/i, '');
  const skuImageByKey = new Map((detail.images ?? [])
    .filter((image) => image.image_type === 'sku')
    .map((image) => [normalizeImageKey(image.source_url), image]));
  const rawOptions = Array.isArray(raw.skuOptions) ? raw.skuOptions : [];
  const translatedOptions = Array.isArray(translation?.sku_options) ? translation.sku_options : [];
  const translatedDimensions = Array.isArray(translation?.sku_dimensions) ? translation.sku_dimensions : [];
  // The translated indices point at the option order captured WHEN the
  // translation was made. The stored source snapshot keeps that order, so the
  // original text must be read from there, not from the (possibly re-imported)
  // current raw options.
  const sourceOptions = Array.isArray(translation?.source_data?.skuOptions)
    ? translation.source_data.skuOptions : [];
  const sourceTextByIndex = new Map(sourceOptions.map((option, position) => [
    Number(option?.index ?? position), String(option?.text ?? ''),
  ]));
  const rawByText = new Map();
  for (const option of rawOptions) {
    if (option?.text) rawByText.set(String(option.text), option);
  }
  const isColour = (name) => /(颜色|color|colour)/i.test(String(name ?? ''));
  const isSize = (name) => /(尺码|尺寸|码数|size)/i.test(String(name ?? ''));
  const colourOptions = translatedOptions.length
    ? translatedOptions.filter((option) => isColour(option?.dimensionName)).map((option) => {
      const source = sourceTextByIndex.get(Number(option?.index)) ?? null;
      const rawMatch = source ? rawByText.get(source) : null;
      return {
        value: String(option?.text ?? ''),
        source,
        imageUrl: option?.imageUrl ?? rawMatch?.image ?? null,
      };
    })
    : rawOptions.filter((option) => isColour(option?.dimensionName))
      .map((option) => ({ value: String(option?.text ?? ''), source: null, imageUrl: option?.image ?? null }));
  const swatches = colourOptions.map((option) => {
    const matched = option.imageUrl ? skuImageByKey.get(normalizeImageKey(option.imageUrl)) : null;
    const base = matched ? imagePublicPath(matched.storage_path) : null;
    return {
      value: option.value,
      source: option.source && option.source !== option.value ? option.source : null,
      thumb: base ? `${base}?w=96` : (option.imageUrl || null),
    };
  }).filter((swatch) => swatch.value);
  const sizeDimension = translatedDimensions.find((dimension) => isSize(dimension?.name))
    ?? (Array.isArray(raw.skuDimensions) ? raw.skuDimensions.find((dimension) => isSize(dimension?.name)) : null);
  const sizes = (Array.isArray(sizeDimension?.values) ? sizeDimension.values : []).map((value) => String(value));
  const sizesTranslated = translatedOptions.length > 0 || translatedDimensions.length > 0;
  const galleryImages = (detail.images ?? [])
    .filter((image) => image.image_type === 'main' || image.image_type === 'gallery')
    .sort((left, right) => (left.image_type !== right.image_type
      ? (left.image_type === 'main' ? -1 : 1) : Number(left.sort_order) - Number(right.sort_order)))
    .map((image) => {
      const base = imagePublicPath(image.storage_path);
      return { id: String(image.id), type: image.image_type, thumb: base ? `${base}?w=160` : (image.source_url || null) };
    });
  const payloadMeta = publication?.payload?.meta ?? {};
  const payloadColors = publication?.payload?.colors?.colors ?? [];
  const payloadSizes = publication?.payload?.sizes?.sizes ?? [];
  const updatedAt = publication?.updated_at ? String(publication.updated_at) : null;
  return {
    productDetailId: detail.id,
    offerId: detail.offer_id,
    sourceTitle: detail.title,
    wp: {
      status: publication?.wp_status ?? null,
      styleNo: publication?.style_no ?? null,
      url: publication?.wp_url ?? null,
      postId: publication?.wp_post_id ?? null,
      externalId: publication?.external_id ?? null,
      lastError: publication?.last_error ?? null,
      updatedAt,
    },
    translation: translation ? {
      id: translation.id,
      title: translation.title ?? null,
      description: translation.description ?? null,
      model: translation.model ?? null,
      createdAt: translation.created_at ?? null,
    } : null,
    merchandising: publication ? {
      primaryCategory: payloadMeta.primary_category ?? null,
      primaryCategoryId: payloadMeta.primary_category_id ?? null,
      material: payloadMeta.material ?? null,
      tags: publication.payload?.tags ?? [],
      categoryIds: publication.payload?.category_ids ?? [],
      tagIds: publication.payload?.tag_ids ?? [],
    } : null,
    price: {
      currency: detail.currency ?? 'CNY',
      moq: detail.moq ?? null,
      sourceMin: detail.price_min === null ? null : Number(detail.price_min),
      sourceMax: detail.price_max === null ? null : Number(detail.price_max),
      skuPriceMax,
      verified: priceInfo.verified === true,
      priceSource: priceInfo.source ?? null,
      tiers: (detail.priceTiers ?? []).map((tier) => ({
        minQuantity: tier.min_quantity === null ? null : Number(tier.min_quantity),
        price: tier.price === null ? null : Number(tier.price),
      })),
      pricing,
      samplePrice: '50.00',
      moqText: '50 pcs',
      retailAvailable: allInStock,
      stockKnown,
    },
    images: {
      gallery: galleryImages,
      swatches,
      sizes,
      variantsTranslated: sizesTranslated,
      dedupe: raw.imageDedupe ?? null,
      descriptionCount: (detail.images ?? []).filter((image) => image.image_type === 'description').length,
      publishedImageCount: Array.isArray(publication?.payload?.images) ? publication.payload.images.length : null,
      publishedColorCount: payloadColors.length || null,
      publishedSizeCount: payloadSizes.length || null,
    },
    variants: {
      dimensions: raw.skuDimensions ?? [],
      rows: skuRows.slice(0, 60).map((row) => ({
        skuKey: row.sku_key,
        options: row.option_data ?? {},
        price: row.price === null ? null : Number(row.price),
        stock: row.stock === null ? null : Number(row.stock),
        skuId: row.sku_id ?? null,
      })),
      total: skuRows.length,
    },
    normalization: normalization
      ? {
        result: decorateNormalization(normalization.result, detail),
        model: normalization.model ?? null,
        updatedAt: normalization.updated_at ?? null,
        // Recomputed from the live SKU rows so price/stock stay current after
        // re-captures or price backfills; falls back to the stored snapshot.
        variantSkus: (() => {
          try {
            const styleNo = publication?.style_no ?? normalization.result?.styleNo ?? null;
            const computed = composeVariantSkus(detail, normalization, styleNo);
            if (Array.isArray(computed) && computed.length) return computed;
          } catch { /* fall back to the stored snapshot */ }
          return Array.isArray(normalization.result?.variantSkus) ? normalization.result.variantSkus : null;
        })(),
        styleNo: publication?.style_no ?? normalization.result?.styleNo ?? null,
      }
      : null,
    gates: {
      bundle: {
        status: detail.bundle_status ?? null,
        manual: detail.bundle_manual_status ?? null,
        reason: detail.bundle_analysis?.reason ?? null,
      },
      duplicate: detail.duplicate_status ?? null,
      gallery: {
        source: raw.gallery?.source ?? null,
        complete: raw.gallery?.complete === true,
      },
      shopPolicy: { allowed: policy.allowed, reason: policy.reason ?? null },
      priceVerified: priceInfo.verified === true,
      hasTranslation: Boolean(translation),
      hasPublication: Boolean(publication?.wp_post_id),
    },
    dates: {
      publicationDate: detail.publication_date ? String(detail.publication_date) : null,
      publicationDateSource: detail.publication_date_source ?? null,
      arrivalDate: get1688ArrivalDate(detail) ?? null,
      firstSeen: detail.first_seen_at ? String(detail.first_seen_at) : null,
      lastCrawled: detail.last_crawled_at ? String(detail.last_crawled_at) : null,
    },
  };
});

// Refresh re-sync for already-published, non-bundle products: rebuilds the WP
// payload from the existing translation + the latest images (deduped) +
// normalized variants, REUSES the attachments already on WordPress (uploads
// only new images), keeps the stored taxonomies/material/style number (no
// merchandising model call) and syncs to the same post. Five-way concurrency.
const wordpressRefreshJobs = new Map();

app.post('/api/wordpress/refresh-published', { preHandler: requireApiKey }, async (request, reply) => {
  if ([...wordpressRefreshJobs.values()].some((job) => job.status === 'running')) {
    return reply.code(409).send({ error: 'refresh_already_running' });
  }
  const ids = Array.isArray(request.body?.ids)
    ? request.body.ids.map(Number).filter((value) => Number.isInteger(value) && value > 0).slice(0, 500)
    : null;
  const id = crypto.randomUUID();
  const job = {
    id, status: 'running', total: 0, processed: 0, updated: 0, skipped: 0, failed: 0,
    imagesRemoved: 0, imagesAdded: 0, mediaReused: 0, mediaUploaded: 0, variantChanges: 0,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null,
    results: [], errors: [],
  };
  wordpressRefreshJobs.set(id, job);
  trimTerminalJobs(wordpressRefreshJobs);
  (async () => {
    try {
      const rows = ids ? ids.map((value) => ({ product_detail_id: value }))
        : await db.listRefreshablePublications({ limit: 5000, offset: 0 });
      job.total = rows.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (true) {
          const index = next++;
          if (index >= rows.length) return;
          const productDetailId = Number(rows[index].product_detail_id);
          job.processed += 1;
          try {
            const detail = await db.getProductDetail(productDetailId);
            const publication = await db.getWordPressPublication(productDetailId);
            const translation = await db.getLatestProductTranslation(productDetailId, 'en');
            if (!detail || !publication?.wp_post_id || !publication.payload || !translation) {
              job.skipped += 1;
              continue;
            }
            const normalization = await db.getVariantNormalization(productDetailId);
            const previousPayload = publication.payload;
            const options = {
              status: 'publish',
              styleNo: publication.style_no ?? '',
              categoryMode: (previousPayload.category_ids ?? []).length ? 'manual' : 'auto',
              categoryIds: previousPayload.category_ids ?? [],
              tagMode: ((previousPayload.tag_ids ?? []).length || (previousPayload.tags ?? []).length) ? 'manual' : 'auto',
              tagIds: previousPayload.tag_ids ?? [],
              tags: previousPayload.tags ?? [],
              primaryCategoryId: Number(previousPayload.meta?.primary_category_id) || 0,
              material: previousPayload.meta?.material ?? '',
              imageMode: 'translated',
              allowUnverifiedGallery: detail.raw_data?.gallery?.complete !== true,
              reuseMedia: true,
              previousPayload,
              normalizedVariants: normalization?.result
                ? { colours: normalization.result.colours ?? [], sizes: normalization.result.sizes ?? [] }
                : null,
            };
            const published = await publishProductToWordPress({
              detail, translation, options, config,
              optionOverrides: await db.listProductOptionOverrides(productDetailId),
            });
            const payload = published.payload;
            const syncHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            await db.saveWordPressPublication(productDetailId, {
              translationId: translation.id, externalId: published.draft.externalId,
              styleNo: published.draft.styleNo,
              wpPostId: published.wordpress.post_id ?? publication.wp_post_id,
              wpUrl: published.wordpress.permalink ?? publication.wp_url,
              wpEditUrl: published.wordpress.edit_link ?? publication.wp_edit_url,
              wpStatus: published.wordpress.status ?? 'publish',
              syncHash, payload, result: published.wordpress, lastError: null,
            });
            const beforeImages = new Set((previousPayload.images ?? [])
              .map((image) => normalizedImageUrl(image?.source_url)).filter(Boolean));
            const afterImages = new Set((payload.images ?? [])
              .map((image) => normalizedImageUrl(image?.source_url)).filter(Boolean));
            const removed = [...beforeImages].filter((key) => !afterImages.has(key)).length;
            const added = [...afterImages].filter((key) => !beforeImages.has(key)).length;
            const labelsBefore = (previousPayload.colors?.colors ?? []).map((colour) => `${colour.label}|${colour.code ?? ''}`).join('\u0001');
            const labelsAfter = (payload.colors?.colors ?? []).map((colour) => `${colour.label}|${colour.code ?? ''}`).join('\u0001');
            const variantChanges = labelsBefore !== labelsAfter ? 1 : 0;
            const reused = published.media.filter((item) => item.reused).length;
            job.updated += 1;
            job.imagesRemoved += removed;
            job.imagesAdded += added;
            job.mediaReused += reused;
            job.mediaUploaded += published.media.length - reused;
            job.variantChanges += variantChanges;
            if (job.results.length < 400) {
              job.results.push({
                productDetailId, styleNo: published.draft.styleNo,
                imagesBefore: beforeImages.size, imagesAfter: afterImages.size,
                removed, added, variantChanges: variantChanges === 1, reused, uploaded: published.media.length - reused,
              });
            }
          } catch (error) {
            job.failed += 1;
            if (job.errors.length < 200) {
              job.errors.push({ productDetailId, message: String(error?.message || error).slice(0, 200) });
            }
          }
        }
      });
      await Promise.all(workers);
      job.status = job.failed ? 'completed_with_errors' : 'completed';
      job.bestSellers = await refreshBestSellersCategory();
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 300);
      app.log.error({ err: error, jobId: id }, 'published refresh job failed');
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/wordpress-refresh-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = wordpressRefreshJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// Publish the split products of published bundles: the original post is updated
// with its best-matching split product (same URL/style number), the remaining
// split products are created as NEW drafts with their own style numbers and
// model-picked categories. Five-way concurrency; nothing is deleted.
const splitPublishJobs = new Map();

app.post('/api/wordpress/publish-splits', { preHandler: requireApiKey }, async (request, reply) => {
  if ([...splitPublishJobs.values()].some((job) => job.status === 'running')) {
    return reply.code(409).send({ error: 'split_publish_already_running' });
  }
  const ids = Array.isArray(request.body?.ids)
    ? request.body.ids.map(Number).filter((value) => Number.isInteger(value) && value > 0).slice(0, 200)
    : null;
  const id = crypto.randomUUID();
  const job = {
    id, status: 'running', total: 0, processed: 0, bundles: 0, keeperUpdated: 0, created: 0, failed: 0,
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null,
    results: [], errors: [],
  };
  splitPublishJobs.set(id, job);
  trimTerminalJobs(splitPublishJobs);
  (async () => {
    try {
      const rows = ids ? ids.map((value) => ({ product_detail_id: value }))
        : await db.listSplitPublishableBundles({ limit: 2000, offset: 0 });
      job.total = rows.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (true) {
          const index = next++;
          if (index >= rows.length) return;
          const productDetailId = Number(rows[index].product_detail_id);
          job.processed += 1;
          try {
            const detail = await db.getProductDetail(productDetailId);
            const publication = await db.getWordPressPublication(productDetailId);
            const contents = await db.getSplitContents(productDetailId);
            if (!detail || !publication?.payload || !contents?.result?.products?.length) {
              job.failed += 1;
              job.errors.push({ productDetailId, message: 'missing plan/contents/publication' });
              continue;
            }
            let plan = null;
            try { plan = (await db.getProductSplitPlan(productDetailId))?.plan ?? null; } catch { plan = null; }
            const result = await publishSplitProductsToWordPress({
              detail, contents: contents.result, publication, plan, config,
            });
            if (result.keeper) {
              const keeperPayload = result.keeper.payload;
              const syncHash = crypto.createHash('sha256').update(JSON.stringify(keeperPayload)).digest('hex');
              await db.saveWordPressPublication(productDetailId, {
                translationId: publication.translation_id,
                externalId: publication.external_id,
                styleNo: result.keeper.styleNo ?? publication.style_no,
                wpPostId: result.keeper.postId,
                wpUrl: result.keeper.url,
                wpEditUrl: publication.wp_edit_url,
                wpStatus: 'publish',
                syncHash, payload: keeperPayload,
                result: { ...(publication.result ?? {}), split_publish: true },
                lastError: null,
              });
              job.keeperUpdated += 1;
              if (result.keeper.renumbered) {
                try { await scheduleProductRagSync(productDetailId, { trigger: 'wordpress_split_renumber' }); } catch { /* keep publishing */ }
              }
            }
            const wpEntries = [
              ...(result.keeper ? [{
                productId: result.keeper.productId,
                wp: { postId: result.keeper.postId, url: result.keeper.url, styleNo: result.keeper.styleNo, status: 'publish', role: 'keeper', externalId: result.keeper.externalId },
                fields: { title: result.keeper.title, description: result.keeper.description },
              }] : []),
              ...result.created.map((item) => ({
                productId: item.productId,
                wp: { postId: item.postId, url: item.url, styleNo: item.styleNo, status: item.status, categoryId: item.categoryId, role: 'split', externalId: item.externalId },
                fields: { title: item.title, description: item.description },
              })),
            ];
            if (wpEntries.length) await db.mergeSplitContentWpResults(productDetailId, wpEntries);
            job.bundles += 1;
            job.created += result.created.length;
            if (result.errors.length) {
              job.errors.push({ productDetailId, message: result.errors.map((entry) => entry.message).join(' | ').slice(0, 200) });
            }
            if (job.results.length < 300) {
              job.results.push({
                productDetailId, styleNo: publication.style_no,
                keeper: result.keeper ? { title: result.keeper.title, images: result.keeper.imageCount, skippedImages: result.keeper.skippedImages } : null,
                created: result.created.map((item) => ({ title: item.title, styleNo: item.styleNo, category: item.categoryName, postId: item.postId })),
                errors: result.errors,
              });
            }
          } catch (error) {
            job.failed += 1;
            if (job.errors.length < 200) {
              job.errors.push({ productDetailId, message: String(error?.message || error).slice(0, 200) });
            }
          }
        }
      });
      await Promise.all(workers);
      job.status = (job.failed || job.errors.length) ? 'completed_with_errors' : 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 300);
      app.log.error({ err: error, jobId: id }, 'split publish job failed');
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/wordpress-split-publish-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = splitPublishJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// Finalize splits: download the bundle's detail images, re-sync every split
// product (uploading the newly downloaded images) and PUBLISH the created
// drafts (keeping their source publication date). Five-way concurrency.
const finalizeSplitJobs = new Map();

app.post('/api/wordpress/finalize-splits', { preHandler: requireApiKey }, async (request, reply) => {
  if ([...finalizeSplitJobs.values()].some((job) => job.status === 'running')) {
    return reply.code(409).send({ error: 'finalize_already_running' });
  }
  const ids = Array.isArray(request.body?.ids)
    ? request.body.ids.map(Number).filter((value) => Number.isInteger(value) && value > 0).slice(0, 200)
    : null;
  const id = crypto.randomUUID();
  const job = {
    id, status: 'running', total: 0, processed: 0, bundles: 0, imagesDownloaded: 0, imagesUploaded: 0,
    published: 0, failed: 0, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    completedAt: null, results: [], errors: [],
  };
  finalizeSplitJobs.set(id, job);
  trimTerminalJobs(finalizeSplitJobs);
  (async () => {
    try {
      const rows = ids ? ids.map((value) => ({ product_detail_id: value }))
        : await db.listSplitPublishableBundles({ limit: 2000, offset: 0 });
      job.total = rows.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (true) {
          const index = next++;
          if (index >= rows.length) return;
          const productDetailId = Number(rows[index].product_detail_id);
          job.processed += 1;
          try {
            let detail = await db.getProductDetail(productDetailId);
            const publication = await db.getWordPressPublication(productDetailId);
            const contents = await db.getSplitContents(productDetailId);
            let plan = null;
            try { plan = (await db.getProductSplitPlan(productDetailId))?.plan ?? null; } catch { plan = null; }
            if (!detail || !publication?.payload || !contents?.result?.products?.length) {
              job.failed += 1;
              job.errors.push({ productDetailId, message: 'missing plan/contents/publication' });
              continue;
            }
            const assignedDetailUrls = [];
            for (const product of contents.result.products) {
              for (const url of product.imageRefs?.imageUrls ?? []) assignedDetailUrls.push(String(url));
            }
            const downloaded = await ensureDescriptionImages(detail, assignedDetailUrls)
              .catch(() => ({ downloaded: 0 }));
            if (downloaded.downloaded) {
              job.imagesDownloaded += downloaded.downloaded;
              detail = await db.getProductDetail(productDetailId);
            }
            const result = await publishSplitProductsToWordPress({
              detail, contents: contents.result, publication, plan, config,
            });
            if (result.keeper) {
              const keeperPayload = result.keeper.payload;
              const syncHash = crypto.createHash('sha256').update(JSON.stringify(keeperPayload)).digest('hex');
              await db.saveWordPressPublication(productDetailId, {
                translationId: publication.translation_id,
                externalId: publication.external_id,
                styleNo: result.keeper.styleNo ?? publication.style_no,
                wpPostId: result.keeper.postId,
                wpUrl: result.keeper.url,
                wpEditUrl: publication.wp_edit_url,
                wpStatus: 'publish',
                syncHash, payload: keeperPayload,
                result: { ...(publication.result ?? {}), split_publish: true },
                lastError: null,
              });
              if (result.keeper.renumbered) {
                try { await scheduleProductRagSync(productDetailId, { trigger: 'wordpress_split_renumber' }); } catch { /* keep publishing */ }
              }
            }
            // Publish the draft split products and keep the source date.
            const publicationDate = detail.publication_date
              ? new Date(detail.publication_date).toISOString() : null;
            const publishedCreates = [];
            for (const created of result.created) {
              if (!created.postId) continue;
              try {
                await setWordPressProductStatus({ postId: created.postId, status: 'publish', config });
                if (publicationDate) {
                  await setWordPressProductPublicationDate({
                    postId: created.postId, publicationDate, config,
                  }).catch(() => {});
                }
                publishedCreates.push({ ...created, status: 'publish' });
                job.published += 1;
              } catch (error) {
                publishedCreates.push(created);
                job.errors.push({ productDetailId, message: `publish failed for ${created.styleNo}: ${String(error?.message || error).slice(0, 120)}` });
              }
            }
            const wpEntries = [
              ...(result.keeper ? [{
                productId: result.keeper.productId,
                wp: { postId: result.keeper.postId, url: result.keeper.url, styleNo: result.keeper.styleNo, status: 'publish', role: 'keeper', externalId: result.keeper.externalId },
                fields: { title: result.keeper.title, description: result.keeper.description },
              }] : []),
              ...publishedCreates.map((item) => ({
                productId: item.productId,
                wp: { postId: item.postId, url: item.url, styleNo: item.styleNo, status: item.status ?? 'publish', categoryId: item.categoryId, role: 'split', externalId: item.externalId },
                fields: { title: item.title, description: item.description },
              })),
            ];
            if (wpEntries.length) await db.mergeSplitContentWpResults(productDetailId, wpEntries);
            job.bundles += 1;
            job.imagesUploaded += result.keeper?.imageCount ?? 0;
            if (job.results.length < 300) {
              job.results.push({
                productDetailId, styleNo: publication.style_no,
                detailImagesDownloaded: downloaded.downloaded,
                keeper: result.keeper ? { images: result.keeper.imageCount, skipped: result.keeper.skippedImages } : null,
                publishedProducts: publishedCreates.map((item) => item.styleNo),
                errors: result.errors,
              });
            }
          } catch (error) {
            job.failed += 1;
            if (job.errors.length < 200) {
              job.errors.push({ productDetailId, message: String(error?.message || error).slice(0, 200) });
            }
          }
        }
      });
      await Promise.all(workers);
      job.status = (job.failed || job.errors.length) ? 'completed_with_errors' : 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 300);
      app.log.error({ err: error, jobId: id }, 'finalize splits job failed');
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/wordpress-finalize-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = finalizeSplitJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// ---------------------------------------------------------------------------
// Unified product pipeline.
//
// capture → bundle judgement → split (category + image assignment + placeholder
// drop) → variant normalization (unusable variants and fully unusable products
// are dropped) → image dedupe (gallery + detail images merged) → copy (English
// title/description generated AFTER dedupe, grounded in the option texts) →
// WordPress publish → Feishu summary. Every step persists its outcome, so a
// rerun is idempotent and the /products review layer can inspect it.
// ---------------------------------------------------------------------------
const pipelineJobs = new Map();

function pipelineModelConfig() {
  return {
    apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
    model: config.complexModel, reasoningEffort: config.reasoningEffort,
  };
}

/** Image dedupe for a regular product's publish image set (gallery + main). */
async function runRegularDedupeStep(detail) {
  const candidates = (detail.images ?? [])
    .filter((image) => image.image_type === 'main' || image.image_type === 'gallery')
    .sort((left, right) => (left.image_type !== right.image_type
      ? (left.image_type === 'main' ? -1 : 1) : Number(left.sort_order) - Number(right.sort_order)))
    .map((image) => ({
      id: String(image.id), type: image.image_type, sortOrder: Number(image.sort_order) || 0,
      sourceUrl: image.source_url ?? null, storagePath: image.storage_path ?? null,
      contentSha256: image.content_sha256 ?? null,
      url: (/^https:\/\//i.test(image.source_url || '') ? String(image.source_url) : null)
        || (imagePublicPath(image.storage_path) ? `${config.publicBaseUrl}${imagePublicPath(image.storage_path)}` : null),
    }));
  const hashResult = await dedupeImagesByHash(candidates);
  let llm = { removed: [], skipped: true };
  try {
    llm = await dedupeImagesWithLlm({
      images: hashResult.kept, title: detail.title ?? '', config: pipelineModelConfig(),
    });
  } catch { /* keep the hash-only result */ }
  const removed = [...hashResult.removed, ...(llm.removed ?? [])];
  const result = {
    version: 2, mode: 'hash+llm', model: config.complexModel ?? null, total: candidates.length,
    keptIds: hashResult.kept
      .filter((image) => !(llm.removed ?? []).some((entry) => entry.imageId === String(image.id)))
      .map((image) => String(image.id)),
    removed,
    counts: {
      exact: hashResult.removed.filter((entry) => entry.reason === 'exact').length,
      near: hashResult.removed.filter((entry) => entry.reason === 'near').length,
      'source-url': hashResult.removed.filter((entry) => entry.reason === 'source-url').length,
      llm: (llm.removed ?? []).length,
    },
    updatedAt: new Date().toISOString(),
  };
  await db.updateProductRawData(detail.id, { imageDedupe: result });
  return result;
}

/**
 * Regular products: variant normalization, then the drop policy — a variant
 * without a usable name (or a placeholder) is discarded; when nothing usable
 * remains the product itself is dropped. SKUs are recomposed afterwards.
 */
async function runRegularVariantStep(detail) {
  const ensured = await ensureSkuSwatchImages(detail).catch(() => ({ downloaded: 0, failed: 0 }));
  const freshDetail = ensured.downloaded ? await db.getProductDetail(detail.id) : detail;
  const { result } = await normalizeVariants({
    detail: freshDetail, config: pipelineModelConfig(), baseUrl: config.publicBaseUrl,
  });
  const { kept: keptColours, dropped: droppedColours } = applyVariantDropPolicy(result.colours ?? []);
  const saved = await db.saveVariantNormalization(
    detail.id, { ...result, colours: keptColours }, config.complexModel ?? null,
  );
  await db.updateProductRawData(detail.id, {
    variantDrops: {
      colours: droppedColours, policy: 'pipeline', droppedAt: new Date().toISOString(),
    },
  });
  let skus = 0;
  if (keptColours.length) {
    const publication = await db.getWordPressPublication(detail.id);
    const composed = await saveComposedSkus(await db.getProductDetail(detail.id), saved, publication?.style_no ?? null);
    skus = composed?.rows?.length ?? 0;
  }
  return {
    dropped: keptColours.length === 0,
    colours: keptColours.length, droppedColours, skus,
  };
}

/**
 * Removes non-product images (factory/office/packing/text posters/company
 * intro) from a bundle's split contents — detail-section images AND gallery
 * images alike. Every product keeps at least its first image. Mutates contents.
 */
async function stripNonProductDetailImages({ detail, contents, config }) {
  const imageById = new Map((detail?.images ?? []).map((image) => [String(image.id), image]));
  const items = [];
  const seen = new Set();
  const addItem = (sourceUrl) => {
    const key = normalizedImageUrl(sourceUrl);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({ key, url: String(sourceUrl) });
  };
  for (const product of contents?.products ?? []) {
    for (const url of product.imageRefs?.imageUrls ?? []) addItem(url);
    for (const id of product.imageRefs?.imageIds ?? []) {
      const image = imageById.get(String(id));
      const sourceUrl = image && /^https:\/\//i.test(image.source_url || '') ? String(image.source_url) : '';
      if (sourceUrl) addItem(sourceUrl);
    }
  }
  if (!items.length) return { removed: 0, considered: 0, nonProduct: 0, errors: [] };
  const junkKeys = new Set();
  const errors = [];
  for (let offset = 0; offset < items.length; offset += 12) {
    try {
      const flagged = await classifyNonProductImages({
        images: items.slice(offset, offset + 12),
        title: detail?.title ?? '',
        config: pipelineModelConfig(),
      });
      for (const key of flagged) junkKeys.add(key);
    } catch (error) {
      errors.push(String(error?.message || error).slice(0, 120));
    }
  }
  if (!junkKeys.size) return { removed: 0, considered: items.length, nonProduct: 0, errors };
  let removed = 0;
  for (const product of contents.products ?? []) {
    if (!product.imageRefs) continue;
    const urls = product.imageRefs.imageUrls ?? [];
    const keptUrls = urls.filter((url) => !junkKeys.has(normalizedImageUrl(url)));
    removed += urls.length - keptUrls.length;
    const ids = product.imageRefs.imageIds ?? [];
    const keptIds = ids.filter((id) => {
      const image = imageById.get(String(id));
      if (!image) return true;
      const sourceUrl = /^https:\/\//i.test(image.source_url || '') ? String(image.source_url) : '';
      return !sourceUrl || !junkKeys.has(normalizedImageUrl(sourceUrl));
    });
    removed += ids.length - keptIds.length;
    // Never leave a product without any image: keep its first one when the
    // classifier flagged everything it had.
    if (!keptUrls.length && !keptIds.length) {
      if (ids.length) keptIds.push(ids[0]);
      else if (urls.length) keptUrls.push(urls[0]);
    }
    product.imageRefs.imageUrls = keptUrls;
    product.imageRefs.imageIds = keptIds;
  }
  return { removed, considered: items.length, nonProduct: junkKeys.size, errors };
}

/** Publish one bundle's split contents and persist every WordPress result. */
async function syncSplitBundle({ productDetailId, detail, publication, contents, plan }) {
  const result = await publishSplitProductsToWordPress({
    detail, contents, publication, plan, skipReview: true, config,
  });
  if (result.keeper) {
    const keeperPayload = result.keeper.payload;
    const syncHash = crypto.createHash('sha256').update(JSON.stringify(keeperPayload)).digest('hex');
    await db.saveWordPressPublication(productDetailId, {
      translationId: publication.translation_id,
      externalId: publication.external_id,
      styleNo: result.keeper.styleNo ?? publication.style_no,
      wpPostId: result.keeper.postId,
      wpUrl: result.keeper.url,
      wpEditUrl: publication.wp_edit_url,
      wpStatus: 'publish',
      syncHash, payload: keeperPayload,
      result: { ...(publication.result ?? {}), split_sync: true },
      lastError: null,
    });
  }
  const publicationDate = detail.publication_date ? new Date(detail.publication_date).toISOString() : null;
  const publishedCreates = [];
  for (const created of result.created ?? []) {
    if (!created.postId) continue;
    await setWordPressProductStatus({ postId: created.postId, status: 'publish', config }).catch(() => {});
    if (publicationDate) {
      await setWordPressProductPublicationDate({ postId: created.postId, publicationDate, config }).catch(() => {});
    }
    publishedCreates.push({ ...created, status: 'publish' });
  }
  const wpEntries = [
    ...(result.keeper ? [{
      productId: result.keeper.productId,
      wp: { postId: result.keeper.postId, url: result.keeper.url, styleNo: result.keeper.styleNo, status: 'publish', role: 'keeper', externalId: result.keeper.externalId },
      fields: { title: result.keeper.title, description: result.keeper.description },
    }] : []),
    ...publishedCreates.map((item) => ({
      productId: item.productId,
      wp: { postId: item.postId, url: item.url, styleNo: item.styleNo, status: 'publish', categoryId: item.categoryId, role: 'split', externalId: item.externalId },
      fields: { title: item.title, description: item.description },
    })),
  ];
  if (wpEntries.length) await db.mergeSplitContentWpResults(productDetailId, wpEntries);
  return { result, publishedCreates };
}

/** Bundle products: split first, then continue as regular split products. */
async function runBundlePipelineStep({ detail, status, publish, refreshSplit = false, run }) {  const planRecord = await db.getProductSplitPlan(detail.id);
  let plan = !refreshSplit && planRecord?.plan?.products?.length ? planRecord.plan : null;
  if (plan) {
    run.steps.split = { products: plan.products.length, source: 'stored' };
  } else {
    const analyzed = await analyzeBundleSplit({
      detail, config: pipelineModelConfig(), baseUrl: config.publicBaseUrl,
    });
    plan = analyzed.plan;
    await db.saveProductSplitPlan(detail.id, plan);
    run.steps.split = {
      products: plan.products.length,
      ignoredOptions: (plan.ignoredOptions ?? []).length,
      source: 'llm',
    };
  }
  // Detail images assigned to the split products must exist locally before
  // dedupe/upload; only the assigned URLs are downloaded.
  const assignedUrls = [];
  for (const product of plan.products ?? []) {
    for (const url of product.imageUrls ?? []) assignedUrls.push(String(url));
  }
  if (assignedUrls.length) {
    const downloaded = await ensureDescriptionImages(detail, assignedUrls)
      .catch(() => ({ downloaded: 0, failed: 0 }));
    if (downloaded.downloaded) detail = await db.getProductDetail(detail.id);
  }
  // A brand-new bundle has no WordPress page yet: publish the anchor page with
  // the regular flow first, then the split publish updates it with the keeper
  // content. Existing pages are reused unchanged.
  let publication = await db.getWordPressPublication(detail.id);
  if (!publication?.payload) {
    let anchorTranslation = await db.getLatestProductTranslation(detail.id, 'en');
    if (!anchorTranslation) {
      const fresh = await db.getProductDetail(detail.id);
      const translated = await translateProductDetail({
        detail: fresh, targetLanguage: 'en',
        config: {
          apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
          complexModel: config.complexModel, storagePath: config.storagePath,
          reasoningEffort: config.reasoningEffort,
          maxTranslationImages: config.translationImageLimit,
          modelImageTransport: config.modelImageTransport,
        },
      });
      anchorTranslation = await db.saveProductTranslation(detail.id, translated);
    }
    const anchored = await publishProductToWordPress({
      detail, translation: anchorTranslation, config,
      optionOverrides: await db.listProductOptionOverrides(detail.id),
      options: {
        status: 'publish', categoryMode: 'auto', tagMode: 'auto', imageMode: 'full',
        allowUnverifiedGallery: detail.raw_data?.gallery?.source === 'linkfox'
          || detail.raw_data?.gallery?.complete === false,
      },
    });
    const anchorHash = crypto.createHash('sha256').update(JSON.stringify(anchored.payload)).digest('hex');
    await db.saveWordPressPublication(detail.id, {
      translationId: anchorTranslation.id,
      externalId: anchored.draft.externalId,
      styleNo: anchored.draft.styleNo,
      wpPostId: anchored.wordpress.post_id ?? null,
      wpUrl: anchored.wordpress.permalink ?? null,
      wpEditUrl: anchored.wordpress.edit_link ?? null,
      wpStatus: anchored.wordpress.status ?? 'publish',
      syncHash: anchorHash, payload: anchored.payload, result: anchored.wordpress, lastError: null,
    });
    publication = await db.getWordPressPublication(detail.id);
  }
  // Split products are regular products: normalization (with the drop policy),
  // dedupe and copy all happen inside the splitter, in that exact order.
  const priorContents = await db.getSplitContents(detail.id);
  const { contents } = await generateSplitContents({
    detail, plan, styleNo: publication?.style_no ?? null,
    config: pipelineModelConfig(), baseUrl: config.publicBaseUrl,
  });
  // Belt and braces: drop any non-product detail image the model still assigned.
  const cleaned = await stripNonProductDetailImages({ detail, contents, config })
    .catch(() => ({ removed: 0, nonProduct: 0 }));
  if (cleaned.removed) run.steps.split.nonProductImagesRemoved = cleaned.removed;
  // Keep the WordPress results of already published split products: their
  // reserved style numbers must survive every content regeneration.
  const priorWp = new Map((priorContents?.result?.products ?? [])
    .map((product) => [String(product.id), product.wp])
    .filter(([, wp]) => wp));
  for (const product of contents.products) {
    const wp = priorWp.get(String(product.id));
    if (wp) product.wp = wp;
  }
  await db.saveSplitContents(detail.id, contents, config.complexModel ?? null);
  run.steps.normalize = { products: contents.products.length, dropped: contents.dropped ?? [] };
  run.dropped = contents.dropped ?? [];
  if (!contents.products.length) {
    await db.upsertPipelineRun(detail.id, {
      status: 'dropped', step: 'split', result: run, lastError: null,
    });
    return { status: 'dropped', run };
  }
  if (!publish) {
    await db.upsertPipelineRun(detail.id, {
      status: 'ready', step: 'publish', result: run, lastError: null,
    });
    return { status: 'ready', run };
  }
  const result = await publishSplitProductsToWordPress({
    detail, contents, publication, plan, config,
  });
  if (result.keeper) {
    const keeperPayload = result.keeper.payload;
    const syncHash = crypto.createHash('sha256').update(JSON.stringify(keeperPayload)).digest('hex');
    await db.saveWordPressPublication(detail.id, {
      translationId: publication?.translation_id ?? null,
      externalId: publication?.external_id ?? keeperPayload.external_id,
      styleNo: result.keeper.styleNo ?? publication?.style_no ?? null,
      wpPostId: result.keeper.postId,
      wpUrl: result.keeper.url,
      wpEditUrl: publication?.wp_edit_url ?? null,
      wpStatus: 'publish',
      syncHash, payload: keeperPayload,
      result: { ...(publication?.result ?? {}), split_publish: true },
      lastError: null,
    });
    if (result.keeper.renumbered) {
      try { await scheduleProductRagSync(detail.id, { trigger: 'wordpress_split_renumber' }); } catch { /* keep going */ }
    }
  }
  const publicationDate = detail.publication_date ? new Date(detail.publication_date).toISOString() : null;
  const publishedCreates = [];
  for (const created of result.created ?? []) {
    if (!created.postId) continue;
    try {
      await setWordPressProductStatus({ postId: created.postId, status: 'publish', config });
      if (publicationDate) {
        await setWordPressProductPublicationDate({ postId: created.postId, publicationDate, config }).catch(() => {});
      }
      publishedCreates.push({ ...created, status: 'publish' });
    } catch (error) {
      publishedCreates.push(created);
      run.errors.push({ productId: created.productId, message: `publish failed for ${created.styleNo}: ${String(error?.message || error).slice(0, 120)}` });
    }
  }
  const wpEntries = [
    ...(result.keeper ? [{
      productId: result.keeper.productId,
      wp: { postId: result.keeper.postId, url: result.keeper.url, styleNo: result.keeper.styleNo, status: 'publish', role: 'keeper', externalId: result.keeper.externalId },
      fields: { title: result.keeper.title, description: result.keeper.description },
    }] : []),
    ...publishedCreates.map((item) => ({
      productId: item.productId,
      wp: { postId: item.postId, url: item.url, styleNo: item.styleNo, status: 'publish', categoryId: item.categoryId, role: 'split', externalId: item.externalId },
      fields: { title: item.title, description: item.description },
    })),
  ];
  if (wpEntries.length) await db.mergeSplitContentWpResults(detail.id, wpEntries);
  run.published = {
    keeper: result.keeper
      ? { styleNo: result.keeper.styleNo, title: result.keeper.title, url: result.keeper.url } : null,
    created: publishedCreates.map((item) => ({
      styleNo: item.styleNo, title: item.title, url: item.url, category: item.categoryName,
    })),
  };
  run.steps.publish = {
    keeper: Boolean(result.keeper),
    created: publishedCreates.length,
    errors: result.errors ?? [],
  };
  await db.upsertPipelineRun(detail.id, {
    status: 'completed', step: 'publish', result: run, publish: true, lastError: null,
  });
  return { status: 'completed', run };
}

/** Regular products: normalization → dedupe → copy → publish. */
async function runRegularPipelineStep({ detail, status, publish, run }) {
  const normalized = await runRegularVariantStep(detail);
  run.steps.normalize = {
    colours: normalized.colours,
    droppedVariants: normalized.droppedColours,
    skus: normalized.skus,
  };
  if (normalized.dropped) {
    await db.upsertPipelineRun(detail.id, {
      status: 'dropped', step: 'normalize', result: run, lastError: null,
    });
    return { status: 'dropped', run };
  }
  const dedupe = await runRegularDedupeStep(detail);
  run.steps.dedupe = dedupe.counts;
  let translation = await db.getLatestProductTranslation(detail.id, 'en');
  if (!translation) {
    const fresh = await db.getProductDetail(detail.id);
    const translated = await translateProductDetail({
      detail: fresh, targetLanguage: 'en',
      config: {
        apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
        complexModel: config.complexModel, storagePath: config.storagePath,
        reasoningEffort: config.reasoningEffort,
        maxTranslationImages: config.translationImageLimit,
        modelImageTransport: config.modelImageTransport,
      },
    });
    translation = await db.saveProductTranslation(detail.id, translated);
    await scheduleProductRagSync(detail.id, { trigger: 'pipeline_translation' }).catch(() => {});
  }
  run.steps.copy = { translationId: translation?.id ?? null, title: translation?.title ?? null };
  if (!publish) {
    await db.upsertPipelineRun(detail.id, {
      status: 'ready', step: 'publish', result: run, lastError: null,
    });
    return { status: 'ready', run };
  }
  const sourceListings = await db.listShopProductSources(detail.offer_id);
  const policy = evaluateShopProductPolicy(sourceListings);
  if (!policy.allowed) {
    await db.upsertPipelineRun(detail.id, {
      status: 'waiting_review', step: 'publish',
      result: { ...run, policy }, lastError: 'shop_product_policy_rejected',
    });
    return { status: 'waiting_review', run };
  }
  const fresh = await db.getProductDetail(detail.id);
  const normalizationRecord = await db.getVariantNormalization(detail.id);
  const published = await publishProductToWordPress({
    detail: fresh, translation, config,
    optionOverrides: await db.listProductOptionOverrides(detail.id),
    options: {
      status, categoryMode: 'auto', tagMode: 'auto', imageMode: 'full',
      normalizedVariants: normalizationRecord?.result ?? null,
      allowUnverifiedGallery: fresh.raw_data?.gallery?.source === 'linkfox'
        || fresh.raw_data?.gallery?.complete === false,
    },
  });
  const wp = published.wordpress;
  // Recompose the variant SKUs with the freshly allocated style number so the
  // published supplier SKUs follow {STYLE}-{CODE}-{SIZE}, then re-sync once.
  let payload = published.payload;
  try {
    const composed = await saveComposedSkus(
      await db.getProductDetail(detail.id), normalizationRecord, published.draft.styleNo,
    );
    const byKey = new Map((composed?.rows ?? []).map((row) => [String(row.skuKey), row.sku]));
    if (byKey.size) {
      payload = structuredClone(published.payload);
      let changed = false;
      for (const row of payload.sku_matrix?.rows ?? []) {
        const sku = byKey.get(String(row.source_sku_key));
        if (sku && row.supplier_sku !== sku) { row.supplier_sku = sku; changed = true; }
      }
      if (changed) {
        const replayed = await updateWordPressProductStyleNumber({
          publication: { payload }, styleNo: published.draft.styleNo, config,
        });
        payload = replayed.payload;
      }
    }
  } catch { /* style-prefixed SKUs are best-effort */ }
  const syncHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await db.saveWordPressPublication(detail.id, {
    translationId: translation.id, externalId: published.draft.externalId, styleNo: published.draft.styleNo,
    wpPostId: wp.post_id ?? null, wpUrl: wp.permalink ?? null, wpEditUrl: wp.edit_link ?? null,
    wpStatus: wp.status ?? status, syncHash, payload, result: wp, lastError: null,
  });
  await scheduleProductRagSync(detail.id, { trigger: 'pipeline_publish' }).catch(() => {});
  run.published = {
    styleNo: published.draft.styleNo, title: translation?.title ?? null,
    url: wp.permalink ?? null, status: wp.status ?? status,
  };
  run.steps.publish = { postId: wp.post_id ?? null, styleNo: published.draft.styleNo };
  await db.upsertPipelineRun(detail.id, {
    status: 'completed', step: 'publish', result: run, publish: true, lastError: null,
  });
  return { status: 'completed', run };
}

/**
 * One product through the whole pipeline. A manual bundle verdict always wins;
 * a failed bundle model call never guesses (the product waits for review).
 */
async function runProductPipeline({ productDetailId, status = 'publish', publish = true, refreshSplit = false }) {
  const run = {
    productDetailId, startedAt: new Date().toISOString(),
    steps: {}, dropped: [], published: null, errors: [],
  };
  await db.upsertPipelineRun(productDetailId, {
    status: 'running', step: 'bundle', publish, startedAt: new Date().toISOString(), lastError: null,
  });
  const detail = await db.getProductDetail(productDetailId);
  if (!detail) throw new Error('product_detail_not_found');
  let verdict = detail.bundle_manual_status || null;
  let verdictSource = detail.bundle_manual_status ? 'manual' : null;
  if (!verdict) {
    const stored = detail.bundle_status && detail.bundle_analysis?.detector
      && detail.bundle_analysis.detector !== 'llm_error';
    if (stored) {
      verdict = detail.bundle_status;
      verdictSource = 'stored';
    } else {
      try {
        const detection = await classifyBundleSemantically({
          data: detail.raw_data ?? {}, title: detail.title ?? '', config: bundleClassifierConfig(config),
        });
        const saved = await db.saveProductBundleStatus(detail.id, detection);
        verdict = saved?.bundle_status ?? detection?.status ?? null;
        verdictSource = 'llm';
        if (verdict === 'bundle' && feishuConfigured(config)) {
          await notifyBundleCapture({
            detailId: detail.id,
            title: detail.title,
            options: (detail.raw_data?.skuOptions ?? [])
              .filter((option) => /(颜色|color|colour)/i.test(String(option?.dimensionName ?? '')))
              .map((option) => option?.text)
              .filter(Boolean),
            reason: detection?.analysis?.reason ?? null,
            config,
          }).catch(() => {});
        }
      } catch (error) {
        await db.upsertPipelineRun(productDetailId, {
          status: 'waiting_review', step: 'bundle',
          result: { ...run, bundleError: String(error?.message || error).slice(0, 300) },
          lastError: 'bundle_classification_failed',
        });
        return { status: 'waiting_review', run };
      }
    }
  }
  run.steps.bundle = { status: verdict, source: verdictSource };
  if (!verdict) {
    await db.upsertPipelineRun(productDetailId, {
      status: 'waiting_review', step: 'bundle', result: run, lastError: 'bundle_verdict_missing',
    });
    return { status: 'waiting_review', run };
  }
  return verdict === 'bundle'
    ? runBundlePipelineStep({ detail, status, publish, refreshSplit, run })
    : runRegularPipelineStep({ detail, status, publish, run });
}

async function notifyPipelineRunSummary(job) {
  if (!feishuConfigured(config)) return { sent: false, reason: 'not_configured' };
  const lines = [
    `🐠 1688 采集流水线完成：${job.total} 个产品｜完成 ${job.completed}｜放弃 ${job.dropped}｜待复核 ${job.waitingReview}｜失败 ${job.failed}`,
  ];
  for (const entry of (job.results ?? []).slice(0, 20)) {
    const pub = entry.published;
    if (entry.status === 'completed' && pub?.keeper) {
      lines.push(`✅ ${pub.keeper.styleNo ?? ''} ${String(pub.keeper.title ?? '').slice(0, 56)} → ${pub.keeper.url ?? ''}`.trim());
      for (const created of pub.created ?? []) {
        lines.push(`　└ ${created.styleNo ?? ''} ${String(created.title ?? '').slice(0, 56)}${created.category ? `（${created.category}）` : ''}`);
      }
    } else if (entry.status === 'completed' && pub) {
      lines.push(`✅ ${pub.styleNo ?? ''} ${String(pub.title ?? '').slice(0, 56)} → ${pub.url ?? ''}`.trim());
    } else if (entry.status === 'dropped') {
      const reasons = [...new Set((entry.dropped ?? []).map((item) => item.reason).filter(Boolean))].join(',');
      lines.push(`⚪️ 放弃 #${entry.productDetailId}${reasons ? `（${reasons}）` : ''}`);
    } else if (entry.status === 'waiting_review') {
      lines.push(`🟡 待复核 #${entry.productDetailId}`);
    }
    const firstError = (entry.errors ?? [])[0];
    if (firstError) lines.push(`⚠️ #${entry.productDetailId}: ${String(firstError.message ?? '').slice(0, 80)}`);
  }
  if ((job.results ?? []).length > 20) lines.push(`…另有 ${job.results.length - 20} 个产品`);
  for (const error of (job.errors ?? []).slice(0, 5)) {
    lines.push(`❌ #${error.productDetailId}: ${String(error.message ?? '').slice(0, 80)}`);
  }
  const result = await sendFeishuText({ text: lines.join('\n'), config });
  return { sent: true, messageId: result.messageId };
}

// Run the pipeline for explicit captures (ids) or for the latest capture of
// each offer (offerIds) — the daily capture task uses offerIds.
app.post('/api/pipelines/run', { preHandler: requireApiKey }, async (request, reply) => {
  const ids = Array.isArray(request.body?.ids)
    ? request.body.ids.map(Number).filter((value) => Number.isInteger(value) && value > 0).slice(0, 200)
    : [];
  const offerIds = Array.isArray(request.body?.offerIds)
    ? request.body.offerIds.map((value) => String(value).trim()).filter(Boolean).slice(0, 200)
    : [];
  if (!ids.length && !offerIds.length) {
    return reply.code(400).send({ error: 'ids_or_offerIds_required' });
  }
  const status = request.body?.status === 'draft' ? 'draft' : 'publish';
  const publish = request.body?.publish !== false;
  const refreshSplit = request.body?.refreshSplit === true;
  const job = {
    id: crypto.randomUUID(), status: 'running', statusTarget: status, publish, refreshSplit,
    total: 0, processed: 0, completed: 0, dropped: 0, waitingReview: 0, failed: 0, skipped: 0,
    results: [], errors: [], createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), completedAt: null,
  };
  pipelineJobs.set(job.id, job);
  trimTerminalJobs(pipelineJobs);
  (async () => {
    try {
      const targets = [...ids];
      for (const offerId of offerIds) {
        const rows = await db.listProductDetails({ offerId, limit: 1 }).catch(() => []);
        const id = Number(rows?.[0]?.id ?? rows?.[0]?.product_detail_id ?? 0);
        if (id) targets.push(id);
      }
      // Blocklisted offers never re-enter the pipeline even if a stale scan
      // listing still names them.
      const blockedTargets = new Set(await db.listBlockedProductDetailIds(targets).catch(() => []));
      for (const blockedId of blockedTargets) {
        job.results.push({ productDetailId: blockedId, status: 'skipped', reason: 'blocked_offer' });
      }
      job.skipped = blockedTargets.size;
      const activeTargets = targets.filter((id) => !blockedTargets.has(id));
      job.total = activeTargets.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(3, activeTargets.length) }, async () => {
        while (true) {
          const index = next++;
          if (index >= activeTargets.length) return;
          const productDetailId = activeTargets[index];
          job.processed += 1;
          try {
            const result = await runProductPipeline({ productDetailId, status, publish, refreshSplit });
            job.results.push({
              productDetailId, status: result.status, steps: result.run.steps,
              dropped: result.run.dropped ?? [], published: result.run.published ?? null,
              errors: result.run.errors ?? [],
            });
            if (result.status === 'completed') job.completed += 1;
            else if (result.status === 'dropped') job.dropped += 1;
            else if (result.status === 'waiting_review') job.waitingReview += 1;
          } catch (error) {
            job.failed += 1;
            if (job.errors.length < 100) {
              job.errors.push({ productDetailId, message: String(error?.message || error).slice(0, 220) });
            }
            await db.upsertPipelineRun(productDetailId, {
              status: 'failed', lastError: String(error?.message || error).slice(0, 300),
            }).catch(() => {});
          }
        }
      });
      await Promise.all(workers);
      job.status = job.failed ? 'completed_with_errors' : 'completed';
      job.bestSellers = await refreshBestSellersCategory();
      // Single-product runs stay silent; only batch runs send the Feishu summary.
      if (job.total > 1) {
        await notifyPipelineRunSummary(job).catch((error) => {
          app.log.error({ err: error, jobId: job.id }, 'pipeline Feishu summary failed');
        });
      }
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 300);
      app.log.error({ err: error, jobId: job.id }, 'pipeline job failed');
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/pipeline-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = pipelineJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

app.get('/api/product-details/:id/pipeline', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const run = await db.getPipelineRun(id);
  return { productDetailId: id, run };
});

app.get('/api/pipelines', { preHandler: requireApiKey }, async (request) => db.listPipelineRuns({
  limit: request.query?.limit, status: request.query?.status ?? null,
}));

// Repair the swatch images of every published split product: re-runs the split
// publish without any model call so each colour option gets its own uploaded
// swatch attachment (older split products were published without one).
const splitSwatchRepairJobs = new Map();

/**
 * Product syncs replace a product's categories, which wipes the out-of-band
 * "Best Sellers" membership — restore it after every bulk re-sync.
 */
async function refreshBestSellersCategory() {
  try {
    const plan = await buildBestSellerPlan(48);
    const result = await replaceWordPressBestSellers({
      postIds: plan.selected.map((item) => item.wp_post_id), config,
    });
    return { selected: plan.selected.length, ...result };
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 200) };
  }
}

app.post('/api/wordpress/split-swatches/repair', { preHandler: requireApiKey }, async (_request, reply) => {
  if ([...splitSwatchRepairJobs.values()].some((job) => job.status === 'running')) {
    return reply.code(409).send({ error: 'split_swatch_repair_already_running' });
  }
  const job = {
    id: crypto.randomUUID(), status: 'running', total: 0, processed: 0, bundles: 0,
    siblings: 0, strippedImages: 0, failed: 0, createdAt: new Date().toISOString(), completedAt: null, errors: [],
  };
  splitSwatchRepairJobs.set(job.id, job);
  trimTerminalJobs(splitSwatchRepairJobs);
  (async () => {
    try {
      const rows = await db.listSplitPublishableBundles({ limit: 2000, offset: 0 });
      job.total = rows.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (true) {
          const index = next++;
          if (index >= rows.length) return;
          const productDetailId = Number(rows[index].product_detail_id);
          job.processed += 1;
          try {
            let detail = await db.getProductDetail(productDetailId);
            const publication = await db.getWordPressPublication(productDetailId);
            const contents = await db.getSplitContents(productDetailId);
            const planRow = await db.getProductSplitPlan(productDetailId).catch(() => null);
            if (!detail || !publication?.payload || !contents?.result?.products?.length) {
              job.failed += 1;
              job.errors.push({ productDetailId, message: 'missing plan/contents/publication' });
              continue;
            }
            const assignedDetailUrls = [];
            for (const product of contents.result.products) {
              for (const url of product.imageRefs?.imageUrls ?? []) assignedDetailUrls.push(String(url));
            }
            if (assignedDetailUrls.length) {
              const downloaded = await ensureDescriptionImages(detail, assignedDetailUrls)
                .catch(() => ({ downloaded: 0 }));
              if (downloaded.downloaded) detail = await db.getProductDetail(productDetailId);
            }
            // Non-product detail images (factory/office/packing/posters) must
            // not appear in the WP galleries: classify and strip only those.
            const cleaned = await stripNonProductDetailImages({ detail, contents: contents.result, config })
              .catch(() => ({ removed: 0, nonProduct: 0 }));
            if (cleaned.removed) {
              await db.saveSplitContents(productDetailId, contents.result, contents.model ?? null);
              job.strippedImages += cleaned.removed;
            }
            const { publishedCreates } = await syncSplitBundle({
              productDetailId, detail, publication, contents: contents.result, plan: planRow?.plan ?? null,
            });
            job.bundles += 1;
            job.siblings += publishedCreates.length;
          } catch (error) {
            job.failed += 1;
            if (job.errors.length < 100) {
              job.errors.push({ productDetailId, message: String(error?.message || error).slice(0, 180) });
            }
          }
        }
      });
      await Promise.all(workers);
      job.status = job.failed ? 'completed_with_errors' : 'completed';
      job.bestSellers = await refreshBestSellersCategory();
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 200);
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/wordpress/split-swatch-repair-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = splitSwatchRepairJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// Full variant repair for every published split product: re-runs the variant
// normalization (swatch text/code/image, sizes, SKUs — model calls per split
// product), strips non-product detail images, saves the refreshed contents and
// re-syncs the WordPress pages. Parallel (6-way) and idempotent.
const splitVariantRepairJobs = new Map();

app.post('/api/wordpress/split-variants/repair', { preHandler: requireApiKey }, async (_request, reply) => {
  if ([...splitVariantRepairJobs.values()].some((job) => job.status === 'running')) {
    return reply.code(409).send({ error: 'split_variant_repair_already_running' });
  }
  const job = {
    id: crypto.randomUUID(), status: 'running', total: 0, processed: 0, bundles: 0,
    siblings: 0, strippedImages: 0, failed: 0, createdAt: new Date().toISOString(), completedAt: null, errors: [],
  };
  splitVariantRepairJobs.set(job.id, job);
  trimTerminalJobs(splitVariantRepairJobs);
  (async () => {
    try {
      const rows = await db.listSplitPublishableBundles({ limit: 2000, offset: 0 });
      job.total = rows.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(6, rows.length) }, async () => {
        while (true) {
          const index = next++;
          if (index >= rows.length) return;
          const productDetailId = Number(rows[index].product_detail_id);
          job.processed += 1;
          try {
            const detail = await db.getProductDetail(productDetailId);
            const publication = await db.getWordPressPublication(productDetailId);
            const contentsRecord = await db.getSplitContents(productDetailId);
            const planRow = await db.getProductSplitPlan(productDetailId).catch(() => null);
            if (!detail || !publication?.payload || !contentsRecord?.result?.products?.length
                || !planRow?.plan?.products?.length) {
              job.failed += 1;
              job.errors.push({ productDetailId, message: 'missing plan/contents/publication' });
              continue;
            }
            const contents = await normalizeSplitContents({
              detail,
              plan: planRow.plan,
              contents: contentsRecord.result,
              styleNo: publication?.style_no ?? null,
              config: {
                apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
                model: config.complexModel, reasoningEffort: config.reasoningEffort,
              },
              baseUrl: config.publicBaseUrl,
            });
            const cleaned = await stripNonProductDetailImages({ detail, contents, config })
              .catch(() => ({ removed: 0 }));
            if (cleaned.removed) job.strippedImages += cleaned.removed;
            await db.saveSplitContents(productDetailId, contents, config.complexModel ?? null);
            const { publishedCreates } = await syncSplitBundle({
              productDetailId, detail, publication, contents, plan: planRow.plan,
            });
            job.bundles += 1;
            job.siblings += publishedCreates.length;
          } catch (error) {
            job.failed += 1;
            if (job.errors.length < 100) {
              job.errors.push({ productDetailId, message: String(error?.message || error).slice(0, 180) });
            }
          }
        }
      });
      await Promise.all(workers);
      job.status = job.failed ? 'completed_with_errors' : 'completed';
      job.bestSellers = await refreshBestSellersCategory();
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 200);
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/wordpress/split-variant-repair-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = splitVariantRepairJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// Regenerate ONLY the title/description of every published split product from
// its deduped images + variant set (single variant names its colour/print,
// multiple variants stay colour-neutral), then re-sync the pages. 6-way parallel.
const splitCopyRepairJobs = new Map();

app.post('/api/wordpress/split-copy/repair', { preHandler: requireApiKey }, async (_request, reply) => {
  if ([...splitCopyRepairJobs.values()].some((job) => job.status === 'running')) {
    return reply.code(409).send({ error: 'split_copy_repair_already_running' });
  }
  const job = {
    id: crypto.randomUUID(), status: 'running', total: 0, processed: 0, bundles: 0,
    products: 0, failed: 0, createdAt: new Date().toISOString(), completedAt: null, errors: [],
  };
  splitCopyRepairJobs.set(job.id, job);
  trimTerminalJobs(splitCopyRepairJobs);
  (async () => {
    try {
      const rows = await db.listSplitPublishableBundles({ limit: 2000, offset: 0 });
      job.total = rows.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(6, rows.length) }, async () => {
        while (true) {
          const index = next++;
          if (index >= rows.length) return;
          const productDetailId = Number(rows[index].product_detail_id);
          job.processed += 1;
          try {
            const detail = await db.getProductDetail(productDetailId);
            const publication = await db.getWordPressPublication(productDetailId);
            const contentsRecord = await db.getSplitContents(productDetailId);
            const planRow = await db.getProductSplitPlan(productDetailId).catch(() => null);
            if (!detail || !publication?.payload || !contentsRecord?.result?.products?.length) {
              job.failed += 1;
              job.errors.push({ productDetailId, message: 'missing contents/publication' });
              continue;
            }
            const updated = await regenerateSplitCopy({
              detail,
              contents: contentsRecord.result,
              config: {
                apiKey: config.modelApiKey, baseUrl: config.modelBaseUrl,
                model: config.complexModel, reasoningEffort: config.reasoningEffort,
              },
              baseUrl: config.publicBaseUrl,
            });
            await db.saveSplitContents(productDetailId, updated, config.complexModel ?? null);
            const { publishedCreates } = await syncSplitBundle({
              productDetailId, detail, publication, contents: updated, plan: planRow?.plan ?? null,
            });
            job.bundles += 1;
            job.products += updated.products.length;
            void publishedCreates;
          } catch (error) {
            job.failed += 1;
            if (job.errors.length < 100) {
              job.errors.push({ productDetailId, message: String(error?.message || error).slice(0, 180) });
            }
          }
        }
      });
      await Promise.all(workers);
      job.status = job.failed ? 'completed_with_errors' : 'completed';
      job.bestSellers = await refreshBestSellersCategory();
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 200);
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/wordpress/split-copy-repair-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = splitCopyRepairJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// Repair keeper categories for every published split bundle: keep only the
// stored reviewed category plus its navigation ancestors (drops the original
// bundle's cross-type categories). Curated collections are preserved. No
// model calls, no media changes.
const splitKeeperCategoryRepairJobs = new Map();

app.post('/api/wordpress/split-keeper-categories/repair', { preHandler: requireApiKey }, async (_request, reply) => {
  if ([...splitKeeperCategoryRepairJobs.values()].some((job) => job.status === 'running')) {
    return reply.code(409).send({ error: 'split_keeper_category_repair_already_running' });
  }
  const job = {
    id: crypto.randomUUID(), status: 'running', total: 0, processed: 0, repaired: 0, unchanged: 0, skipped: 0,
    failed: 0, createdAt: new Date().toISOString(), completedAt: null, results: [], errors: [],
  };
  splitKeeperCategoryRepairJobs.set(job.id, job);
  trimTerminalJobs(splitKeeperCategoryRepairJobs);
  (async () => {
    try {
      const rows = await db.listSplitPublishableBundles({ limit: 2000, offset: 0 });
      job.total = rows.length;
      let next = 0;
      const workers = Array.from({ length: Math.min(5, rows.length) }, async () => {
        while (true) {
          const index = next++;
          if (index >= rows.length) return;
          const productDetailId = Number(rows[index].product_detail_id);
          job.processed += 1;
          try {
            const contents = await db.getSplitContents(productDetailId);
            const keeper = (contents?.result?.products ?? [])
              .find((product) => product?.wp?.role === 'keeper' && product?.wp?.postId);
            if (!keeper) {
              job.skipped += 1;
              continue;
            }
            const publication = await db.getWordPressPublication(productDetailId);
            if (!publication?.payload || !publication.wp_post_id) {
              job.failed += 1;
              job.errors.push({ productDetailId, message: 'missing publication' });
              continue;
            }
            const repaired = await repairSplitKeeperCategories({ publication, config });
            if (repaired.changed) {
              const syncHash = crypto.createHash('sha256').update(JSON.stringify(repaired.payload)).digest('hex');
              await db.saveWordPressPublication(productDetailId, {
                translationId: publication.translation_id,
                externalId: publication.external_id,
                styleNo: publication.style_no,
                wpPostId: publication.wp_post_id,
                wpUrl: publication.wp_url,
                wpEditUrl: publication.wp_edit_url,
                wpStatus: publication.wp_status ?? 'publish',
                syncHash,
                payload: repaired.payload,
                result: publication.result,
                lastError: null,
              });
              job.repaired += 1;
              if (job.results.length < 200) {
                job.results.push({
                  productDetailId, styleNo: publication.style_no,
                  categoryIds: repaired.categoryIds, previousCategoryIds: repaired.previousCategoryIds,
                });
              }
            } else {
              job.unchanged += 1;
            }
          } catch (error) {
            job.failed += 1;
            if (job.errors.length < 200) {
              job.errors.push({ productDetailId, message: String(error?.message || error).slice(0, 200) });
            }
          }
        }
      });
      await Promise.all(workers);
      job.status = job.failed ? 'completed_with_errors' : 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 300);
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/wordpress/split-keeper-category-repair-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = splitKeeperCategoryRepairJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

// One-off repair: after a direct REST classification change on WordPress the
// stored publication payload still carries the previous categories, so any
// payload replay (refresh, price, or style repairs) would write the old terms
// back. This aligns the saved payload with the live WordPress state without
// re-syncing the post.
app.post('/api/wordpress/publication-categories/backfill', { preHandler: requireApiKey }, async (request) => {
  const items = (Array.isArray(request.body?.items) ? request.body.items : []).slice(0, 2000);
  const scheduleRag = request.body?.scheduleRagSync === true;
  const normalizeIds = (values) => [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  const summary = { updated: 0, unchanged: 0, skipped: 0, failed: 0, ragScheduled: 0, errors: [], results: [] };
  let next = 0;
  const workers = Array.from({ length: Math.min(5, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index] ?? {};
      const productDetailId = Number(item.product_detail_id);
      const categoryIds = normalizeIds(item.category_ids);
      const primaryCategoryId = Number(item.primary_category_id);
      try {
        if (!Number.isInteger(productDetailId) || productDetailId <= 0 || !categoryIds.length
          || !categoryIds.includes(primaryCategoryId)) {
          summary.failed += 1;
          if (summary.errors.length < 200) summary.errors.push({ productDetailId: item.product_detail_id, message: 'invalid item' });
          continue;
        }
        const publication = await db.getWordPressPublication(productDetailId);
        if (!publication?.payload || !publication.wp_post_id) {
          summary.skipped += 1;
          continue;
        }
        const previousCategoryIds = normalizeIds(publication.payload.category_ids);
        const previousPrimaryId = Number(publication.payload.meta?.primary_category_id) || 0;
        const categoryName = item.primary_category_name ? String(item.primary_category_name).slice(0, 200) : null;
        if (JSON.stringify(previousCategoryIds) === JSON.stringify(categoryIds)
          && previousPrimaryId === primaryCategoryId
          && (!categoryName || categoryName === publication.payload.meta?.primary_category)) {
          summary.unchanged += 1;
          continue;
        }
        const payload = structuredClone(publication.payload);
        payload.category_ids = categoryIds;
        payload.meta = { ...(payload.meta ?? {}), primary_category_id: String(primaryCategoryId) };
        if (categoryName) payload.meta.primary_category = categoryName;
        const syncHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        await db.saveWordPressPublication(productDetailId, {
          translationId: publication.translation_id,
          externalId: publication.external_id,
          styleNo: publication.style_no,
          wpPostId: publication.wp_post_id,
          wpUrl: publication.wp_url,
          wpEditUrl: publication.wp_edit_url,
          wpStatus: publication.wp_status ?? 'publish',
          syncHash,
          payload,
          result: publication.result,
          lastError: null,
        });
        if (scheduleRag) {
          const rag = await scheduleProductRagSync(productDetailId, { trigger: 'publication_category_backfill' })
            .catch(() => null);
          if (rag?.scheduled) summary.ragScheduled += 1;
        }
        summary.updated += 1;
        if (summary.results.length < 500) {
          summary.results.push({
            productDetailId, styleNo: publication.style_no, categoryIds, previousCategoryIds,
            primaryCategoryId, previousPrimaryId,
          });
        }
      } catch (error) {
        summary.failed += 1;
        if (summary.errors.length < 200) {
          summary.errors.push({ productDetailId: item.product_detail_id, message: String(error?.message || error).slice(0, 200) });
        }
      }
    }
  });
  await Promise.all(workers);
  return summary;
});

// Diagnostic: show what the vision pass would strip for one bundle.
app.post('/api/product-details/:id/classify-detail-images', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const contents = await db.getSplitContents(detail.id);
  if (!contents?.result?.products?.length) return reply.code(409).send({ error: 'split_contents_required' });
  const before = JSON.stringify(contents.result);
  const result = await stripNonProductDetailImages({ detail, contents: contents.result, config })
    .catch((error) => ({ error: String(error?.message || error).slice(0, 200) }));
  return { productDetailId: detail.id, ...result, changed: JSON.stringify(contents.result) !== before };
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
    const blocked = await db.isOfferBlocked(resolvedOfferId);
    if (blocked) {
      return reply.code(409).send({
        error: 'blocked_offer',
        message: '该商品已被列入禁止采集名单（从操作台清退）。',
        blockedAt: blocked.created_at,
      });
    }
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
  const blocked = await db.isOfferBlocked(offerId);
  if (blocked) {
    return reply.code(409).send({
      error: 'blocked_offer',
      message: '该商品已被列入禁止采集名单（从操作台清退）。',
      blockedAt: blocked.created_at,
    });
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
async function removeDetailImageFolders(imageStoragePaths) {
  const root = path.resolve(config.storagePath, 'product-images');
  const folders = new Set();
  for (const storagePath of imageStoragePaths ?? []) {
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
  return foldersRemoved;
}

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
  const foldersRemoved = await removeDetailImageFolders(removed.imageStoragePaths);
  return { deleted: true, ...removed, foldersRemoved };
});

// ---- Console purge: delete everywhere and blocklist the offer -----------------

function productHasActivePublishJob(productDetailId) {
  return [...wordpressJobs.values()].some((job) =>
    Number(job.productDetailId) === Number(productDetailId)
    && ['queued', 'running'].includes(String(job.status ?? '')));
}

// Maintenance jobs that could resurrect or re-write a product mid-purge. Maps
// are read lazily because some are declared later in the module.
function purgeGlobalBlockingJobs() {
  const candidates = () => [
    ['wordpress_refresh', wordpressRefreshJobs],
    ['split_publish', splitPublishJobs],
    ['split_finalize', finalizeSplitJobs],
    ['wordpress_price_repair', wordpressPriceRepairJobs],
    ['wordpress_best_sellers', wordpressBestSellerJobs],
    ['stock_repair', stockRepairJobs],
    ['split_swatch_repair', splitSwatchRepairJobs],
    ['split_variant_repair', splitVariantRepairJobs],
    ['split_copy_repair', splitCopyRepairJobs],
    ['split_keeper_category_repair', splitKeeperCategoryRepairJobs],
  ];
  const blocking = [];
  for (const [type, map] of candidates()) {
    if ([...(map?.values?.() ?? [])].some((job) =>
      ['queued', 'running'].includes(String(job?.status ?? '')))) {
      blocking.push(type);
    }
  }
  return blocking;
}

function purgeBlockingJobs(productDetailId) {
  const blocking = purgeGlobalBlockingJobs();
  if (productHasActivePublishJob(productDetailId)) blocking.unshift('wordpress_publish');
  return blocking;
}

function collectPurgeWpPosts(publication, contents) {
  const posts = [];
  if (publication?.wp_post_id) {
    posts.push({ postId: Number(publication.wp_post_id), role: 'keeper',
      status: publication.wp_status ?? null, url: publication.wp_url ?? null });
  }
  for (const product of contents?.result?.products ?? []) {
    const wp = product?.wp ?? null;
    const postId = Number(wp?.postId);
    if (!Number.isInteger(postId) || postId <= 0) continue;
    if (posts.some((entry) => entry.postId === postId)) continue;
    posts.push({ postId, role: String(wp?.role ?? 'split'), status: wp?.status ?? null,
      title: product?.title ?? null });
  }
  return posts;
}

async function archivePortalPublicationForPurge(productDetailId) {
  const publication = await db.getPortalPublication(productDetailId);
  if (!publication?.portal_product_id) return { status: 'none' };
  const target = publication.result?.target ?? null;
  if (target !== 'staging') return { status: 'skipped', reason: 'target_not_staging' };
  if (!config.portalStagingApiUrl || !config.portalStagingAdminSecret) {
    return { status: 'skipped', reason: 'portal_not_configured' };
  }
  try {
    const response = await fetch(new URL(`/api/v1/admin/catalog/${encodeURIComponent(publication.portal_product_id)}`, config.portalStagingApiUrl), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${config.portalStagingAdminSecret}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok && response.status !== 404) {
      const body = await response.json().catch(() => null);
      return { status: 'failed', message: String(body?.error?.message ?? `Portal returned HTTP ${response.status}`) };
    }
    await db.markPortalPublicationArchived(productDetailId);
    portalStagingActiveCache = { at: 0, ids: null, warning: null };
    return { status: 'archived', alreadyRemoved: response.status === 404 };
  } catch (error) {
    return { status: 'failed', message: String(error?.message ?? error).slice(0, 300) };
  }
}

// What a purge would touch; powers the confirmation dialog on /products.
async function buildPurgePreview(id) {
  const detail = await db.getProductDetail(id);
  if (!detail) return { ok: false, code: 'not_found' };
  const [publication, contents, portal, shopifyRows, blocked, pipeline] = await Promise.all([
    db.getWordPressPublication(id),
    db.getSplitContents(id),
    db.getPortalPublication(id),
    db.listShopifyPublicationsForDetail(id).catch(() => []),
    db.isOfferBlocked(detail.offer_id),
    db.getPipelineRun(id).catch(() => null),
  ]);
  return { ok: true, preview: {
    product: { id: detail.id, offerId: detail.offer_id, title: detail.title,
      styleNo: publication?.style_no ?? null },
    wp: { posts: collectPurgeWpPosts(publication, contents), keeperStatus: publication?.wp_status ?? null },
    portal: portal ? { portalProductId: portal.portal_product_id, status: portal.portal_status,
      target: portal.result?.target ?? null } : null,
    shopify: (shopifyRows ?? []).map((row) => ({ store: row.shopify_store,
      gid: row.shopify_product_gid, url: row.shopify_url, status: row.publication_status })),
    rag: { enabled: ragClient.enabled },
    blocklisted: Boolean(blocked),
    activeJobs: {
      wordpress: productHasActivePublishJob(id),
      pipeline: ['pending', 'running'].includes(String(pipeline?.status ?? '')),
      maintenance: purgeBlockingJobs(id),
    },
  } };
}

app.get('/api/product-details/:id/purge-preview', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const result = await buildPurgePreview(id);
  if (!result.ok) return reply.code(result.code === 'not_found' ? 404 : 500).send({ error: result.code });
  return result.preview;
});

// Batch preview for the checkbox-driven bulk purge on /products.
app.post('/api/product-details/purge-preview-batch', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const ids = [...new Set((Array.isArray(request.body?.ids) ? request.body.ids : [])
    .map(Number).filter((value) => Number.isInteger(value) && value > 0))].slice(0, 100);
  if (!ids.length) return reply.code(400).send({ error: 'ids_required' });
  const previews = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= ids.length) return;
      const id = ids[index];
      try {
        const result = await buildPurgePreview(id);
        previews.push(result.ok ? { id, ok: true, ...result.preview } : { id, ok: false, error: result.code });
      } catch (error) {
        previews.push({ id, ok: false, error: 'preview_failed',
          message: String(error?.message ?? error).slice(0, 200) });
      }
    }
  });
  await Promise.all(workers);
  return { count: ids.length, previews, globalMaintenance: purgeGlobalBlockingJobs() };
});

// Purge one product: WordPress posts (keeper + split family) first, then the
// RAG entity, the staging portal record, the collector capture and finally
// the blocklist entry that stops future captures. Every step is idempotent so
// a failed run can safely be retried. Returns { ok:true, ...summary } or
// { ok:false, code, ...details }.
async function purgeProductEverywhere(id, { wpMode = 'trash', addToBlocklist = true,
  archivePortal = true, force = false } = {}) {
  const detail = await db.getProductDetail(id);
  if (!detail) return { ok: false, code: 'not_found' };
  const blockingJobs = purgeBlockingJobs(id);
  if (blockingJobs.length) {
    return { ok: false, code: 'maintenance_job_running', jobs: blockingJobs,
      message: '有维护任务进行中（发布/刷新/拆分等），请等任务结束后再清退。' };
  }
  const pipeline = await db.getPipelineRun(id).catch(() => null);
  if (['pending', 'running'].includes(String(pipeline?.status ?? ''))) {
    return { ok: false, code: 'pipeline_in_progress',
      message: '该产品有流水线任务进行中，请稍后重试。' };
  }

  const publication = await db.getWordPressPublication(id);
  const contents = await db.getSplitContents(id);
  const wpPosts = collectPurgeWpPosts(publication, contents).map((entry) => entry.postId);

  // 1) WordPress first: if this fails nothing local has been touched yet.
  const wpResults = [];
  const wpErrors = [];
  for (const postId of wpPosts) {
    try {
      wpResults.push(await deleteWordPressProduct({ postId, force: wpMode === 'delete', config }));
    } catch (error) {
      wpErrors.push({ postId, message: String(error?.message ?? error).slice(0, 300) });
    }
  }
  if (wpErrors.length) {
    app.log.error({ productDetailId: id, wpErrors }, 'purge WordPress delete failed');
    return { ok: false, code: 'wordpress_delete_failed', wpResults, wpErrors,
      message: '部分 WordPress 文章删除失败，采集器数据未改动；修复后可直接重试（幂等）。' };
  }

  // 2) RAG deactivate while the capture still exists (clean canonical lookup).
  let ragResult = { status: 'not_configured' };
  if (ragClient.enabled) {
    try {
      await ragClient.deactivate({ canonicalProductId: `1688:${detail.offer_id}`,
        sourceProductId: String(detail.offer_id) });
      ragResult = { status: 'deactivated' };
    } catch (error) {
      app.log.error({ err: error, productDetailId: id }, 'purge RAG deactivate failed');
      if (!force) {
        return { ok: false, code: 'rag_deactivate_failed', wpResults,
          message: 'RAG 反激活失败，采集器数据未删除；可重试，或传 force=true 跳过 RAG 继续。' };
      }
      ragResult = { status: 'failed', message: String(error?.message ?? error).slice(0, 300) };
    }
  }

  // 3) Portal staging archive is best effort (secondary catalog).
  const portalResult = archivePortal ? await archivePortalPublicationForPurge(id) : { status: 'skipped', reason: 'disabled' };

  // 4) Collector hard delete (cascades every child row) + media folders.
  const removed = await db.deleteProductDetail(id);
  if (!removed) return { ok: false, code: 'not_found' };
  const foldersRemoved = await removeDetailImageFolders(removed.imageStoragePaths);

  // 5) Blocklist: future scans and every capture entry point reject the offer.
  let blockedEntry = null;
  if (addToBlocklist && detail.offer_id) {
    blockedEntry = await db.upsertProductBlocklist({
      offerId: detail.offer_id, productDetailId: id,
      styleNo: publication?.style_no ?? null, title: detail.title,
      wpPostIds: wpPosts, reason: 'purged from the products console', blockedBy: 'products-console',
    });
  }
  return {
    ok: true, deleted: true, productDetailId: id, offerId: detail.offer_id,
    wp: { mode: wpMode, posts: wpResults },
    portal: portalResult,
    rag: ragResult,
    foldersRemoved,
    blocked: Boolean(blockedEntry),
  };
}

const PURGE_ERROR_STATUS = { not_found: 404, maintenance_job_running: 409,
  pipeline_in_progress: 409, wordpress_delete_failed: 502, rag_deactivate_failed: 502 };

app.post('/api/product-details/:id/purge', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const body = request.body ?? {};
  const result = await purgeProductEverywhere(id, {
    wpMode: body.wpMode === 'delete' ? 'delete' : 'trash',
    addToBlocklist: body.blocklist !== false,
    archivePortal: body.archivePortal !== false,
    force: body.force === true,
  });
  if (!result.ok) {
    const status = PURGE_ERROR_STATUS[result.code] ?? 500;
    return reply.code(status).send({ ...result, error: result.code });
  }
  return result;
});

// Checkbox-driven bulk purge: same per-product flow, bounded concurrency.
app.post('/api/product-details/purge-batch', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const ids = [...new Set((Array.isArray(request.body?.ids) ? request.body.ids : [])
    .map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  if (!ids.length) return reply.code(400).send({ error: 'ids_required' });
  if (ids.length > 100) return reply.code(400).send({ error: 'too_many_ids', max: 100 });
  const globalMaintenance = purgeGlobalBlockingJobs();
  if (globalMaintenance.length) {
    return reply.code(409).send({ error: 'maintenance_job_running', jobs: globalMaintenance,
      message: '有全局维护任务进行中（刷新/拆分等），请等任务结束后再批量清退。' });
  }
  const body = request.body ?? {};
  const options = {
    wpMode: body.wpMode === 'delete' ? 'delete' : 'trash',
    addToBlocklist: body.blocklist !== false,
    archivePortal: body.archivePortal !== false,
    force: body.force === true,
  };
  const results = [];
  const failures = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= ids.length) return;
      const id = ids[index];
      try {
        const result = await purgeProductEverywhere(id, options);
        if (result.ok) results.push(result);
        else failures.push({ productDetailId: id, error: result.code,
          message: result.message ?? null, jobs: result.jobs ?? null,
          wpErrors: result.wpErrors ?? null });
      } catch (error) {
        app.log.error({ err: error, productDetailId: id }, 'batch purge failed');
        failures.push({ productDetailId: id, error: 'purge_failed',
          message: String(error?.message ?? error).slice(0, 300) });
      }
    }
  });
  await Promise.all(workers);
  return { total: ids.length, deleted: results.length, failed: failures.length, results, failures };
});

// ---- Blocklist management -----------------------------------------------------

app.get('/api/blocklist', { preHandler: requireDashboardOrApiKey }, async () => {
  const entries = await db.listProductBlocklist();
  return { count: entries.length, entries };
});

// Manual block without deleting an existing capture (future captures rejected).
app.post('/api/blocklist', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const offerId = String(request.body?.offerId ?? '').trim();
  if (!/^\d{10,13}$/.test(offerId)) return reply.code(400).send({ error: 'valid_1688_offer_id_required' });
  const entry = await db.upsertProductBlocklist({
    offerId,
    reason: request.body?.reason ? String(request.body.reason).slice(0, 200) : 'manual block from the products console',
    blockedBy: 'products-console',
  });
  return { blocked: true, entry };
});

app.delete('/api/blocklist/:offerId', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const removed = await db.removeProductBlocklist(request.params.offerId);
  if (!removed) return reply.code(404).send({ error: 'not_found' });
  return { removed: true, offerId: String(request.params.offerId) };
});

// One-off maintenance: fill per-SKU prices that earlier LinkFox captures left
// null although the raw skuList carried consignPrice/fenxiaoPriceInfo values.
// Pure local mapping — no LinkFox call, only null prices are touched.
app.post('/api/product-details/backfill-linkfox-sku-prices', { preHandler: requireApiKey }, async (request) => {
  const limit = Number(request.body?.limit) > 0 ? Math.min(Number(request.body.limit), 5000) : 2000;
  const ids = await db.listLinkfoxSkuPriceBackfillCandidates(limit);
  const priceOf = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  let products = 0;
  let updatedRows = 0;
  for (const id of ids) {
    const detail = await db.getProductDetail(id);
    const skuList = (((detail?.raw_data ?? {}).linkfox ?? {}).raw ?? {}).skuList;
    if (!Array.isArray(skuList)) continue;
    const priceBySkuId = {};
    for (const sku of skuList) {
      const skuId = sku?.skuId === null || sku?.skuId === undefined ? '' : String(sku.skuId);
      if (!skuId) continue;
      const price = priceOf(sku.price) ?? priceOf(sku.retailPrice)
        ?? priceOf(sku.consignPrice) ?? priceOf(sku.fenxiaoPriceInfo?.offerPrice);
      if (price !== null) priceBySkuId[skuId] = price;
    }
    const changed = await db.updateProductSkuPricesFromLinkfox(id, priceBySkuId);
    if (changed) { products += 1; updatedRows += changed; }
  }
  return { candidates: ids.length, products, updatedRows, more: ids.length >= limit };
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

// ---- WordPress status truth ------------------------------------------------
// The stored wp_status must converge to the real WordPress state no matter who
// changes it (manual wp-admin edits, bulk edits, other tools). Three inputs:
//   1. WP pushes change events to /api/wordpress/status-events (near real time)
//   2. a periodic live reconcile sweep (self-healing backstop)
//   3. an on-demand sync endpoint used by the products page and the daily task.

async function applyObservedWordpressStatuses(observations, { source = 'reconcile' } = {}) {
  let checked = 0;
  let changed = 0;
  let unmapped = 0;
  const ragScheduled = [];
  for (const observation of observations) {
    const outcome = await db.applyWordpressPostStatus({
      postId: observation.postId,
      newStatus: observation.status,
      source,
      changedBy: observation.changedBy ?? null,
      eventAt: observation.eventAt ?? null,
    }).catch(() => null);
    if (!outcome) { unmapped += 1; continue; }
    checked += 1;
    if (outcome.changed) {
      changed += 1;
      if (outcome.role === 'keeper') ragScheduled.push(outcome);
    }
  }
  for (const outcome of ragScheduled) {
    const trigger = `${source}_${outcome.newStatus === 'publish' ? 'publish' : 'unpublish'}`;
    await scheduleProductRagSync(outcome.productDetailId, { trigger }).catch(() => {});
  }
  return { checked, changed, unmapped, ragScheduled: ragScheduled.length };
}

let wpStatusReconcileRunning = false;

async function runWordpressStatusReconcile({ staleMinutes = config.wpStatusReconcileMinutes,
  keeperLimit = 800 } = {}) {
  if (wpStatusReconcileRunning) return { skipped: 'already_running' };
  if (!config.wordpressBaseUrl || !config.wordpressUsername || !config.wordpressApplicationPassword) {
    return { skipped: 'wordpress_not_configured' };
  }
  wpStatusReconcileRunning = true;
  try {
    const staleBefore = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    const [keeperRows, siblingEntries] = await Promise.all([
      db.listWordpressStatusReconcileTargets({ staleBefore, limit: keeperLimit }),
      db.listSplitContentWpPostEntries(),
    ]);
    const staleSiblings = siblingEntries.filter((entry) => !entry.checkedAt || entry.checkedAt < staleBefore);
    const postIds = [...new Set([
      ...keeperRows.map((row) => Number(row.wp_post_id)),
      ...staleSiblings.map((entry) => entry.postId),
    ])];
    if (!postIds.length) return { checked: 0, changed: 0, posts: 0 };
    const { statuses } = await fetchWordPressProductStatuses({ postIds, config });
    const observations = postIds.map((postId) => ({ postId, status: statuses.get(postId) ?? 'deleted' }));
    const result = await applyObservedWordpressStatuses(observations, { source: 'reconcile' });
    await db.pruneWordpressStatusEvents({ keepDays: 60 }).catch(() => {});
    if (result.changed) {
      app.log.info({ ...result, posts: postIds.length }, 'wordpress status reconcile applied changes');
    }
    return { ...result, posts: postIds.length };
  } finally {
    wpStatusReconcileRunning = false;
  }
}

// Push endpoint for the WordPress site: reports product post status changes.
app.post('/api/wordpress/status-events', { preHandler: requireWpStatusEventToken }, async (request, reply) => {
  const events = Array.isArray(request.body?.events) ? request.body.events.slice(0, 100) : [];
  if (!events.length) return reply.code(400).send({ error: 'events_required' });
  const results = [];
  let changed = 0;
  let unmapped = 0;
  for (const event of events) {
    const postId = Number(event?.postId);
    const newStatus = String(event?.newStatus ?? '').trim().slice(0, 40);
    if (!Number.isInteger(postId) || postId <= 0 || !newStatus) {
      results.push({ postId: event?.postId ?? null, applied: false, reason: 'invalid_event' });
      continue;
    }
    const outcome = await db.applyWordpressPostStatus({
      postId,
      newStatus,
      source: 'wp_event',
      changedBy: event?.changedBy ? String(event.changedBy).slice(0, 120) : null,
      eventAt: event?.changedAt ? String(event.changedAt).slice(0, 40) : null,
    }).catch(() => null);
    if (!outcome) {
      unmapped += 1;
      results.push({ postId, applied: false, reason: 'unmapped' });
      continue;
    }
    if (outcome.changed && outcome.role === 'keeper') {
      changed += 1;
      const trigger = `wp_event_${newStatus === 'publish' ? 'publish' : 'unpublish'}`;
      scheduleProductRagSync(outcome.productDetailId, { trigger }).catch(() => {});
    }
    results.push({ postId, applied: true, role: outcome.role,
      productDetailId: outcome.productDetailId, status: newStatus, changed: outcome.changed });
  }
  return { received: events.length, changed, unmapped, results };
});

// On-demand live check: reads the real WordPress status for the given saved
// products (keeper + split siblings) and refreshes the stored copy.
app.post('/api/wordpress/statuses/sync', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const rawIds = Array.isArray(request.body?.productDetailIds) ? request.body.productDetailIds : [];
  const ids = [...new Set(rawIds.map(Number).filter((value) => Number.isInteger(value) && value > 0))].slice(0, 300);
  if (!ids.length) return reply.code(400).send({ error: 'product_detail_ids_required' });
  const postIds = new Set();
  for (const id of ids) {
    const [publication, contents] = await Promise.all([
      db.getWordPressPublication(id), db.getSplitContents(id),
    ]);
    if (publication?.wp_post_id) postIds.add(Number(publication.wp_post_id));
    for (const product of contents?.result?.products ?? []) {
      const postId = Number(product?.wp?.postId);
      if (Number.isInteger(postId) && postId > 0) postIds.add(postId);
    }
  }
  if (!postIds.size) {
    return { checked: 0, changed: 0, posts: 0, results: [], note: 'no_wordpress_posts_for_details' };
  }
  let statuses;
  try {
    ({ statuses } = await fetchWordPressProductStatuses({ postIds: [...postIds], config }));
  } catch (error) {
    request.log.warn({ err: error }, 'wordpress status sync failed');
    return reply.code(502).send({ error: 'wordpress_unreachable', message: String(error?.message ?? error).slice(0, 300) });
  }
  const observations = [...postIds].map((postId) => ({ postId, status: statuses.get(postId) ?? 'deleted' }));
  const applied = await applyObservedWordpressStatuses(observations, { source: 'reconcile' });
  const results = [];
  for (const id of ids) {
    const publication = await db.getWordPressPublication(id);
    results.push({
      productDetailId: id,
      wpStatus: publication?.wp_status ?? null,
      statusSource: publication?.status_source ?? null,
      statusCheckedAt: publication?.status_checked_at ?? null,
    });
  }
  return { ...applied, posts: postIds.size, results };
});

// Publication overview across every captured product: status totals per shop,
// plus a filterable listing. Bearer or dashboard Basic auth.
app.get('/api/wordpress/publications/summary', { preHandler: requireDashboardOrApiKey }, async () => db.summarizeWordPressPublications());

// 1688 sale quantities for a set of style numbers and/or WordPress post ids
// (latest shop scan per product); used by the portal catalog "Best selling" sort.
app.get('/api/sales/by-styles', { preHandler: requireApiKey }, async (request, reply) => {
  const styles = String(request.query?.styles ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const wpPostIds = String(request.query?.wpPostIds ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!styles.length && !wpPostIds.length) return reply.code(400).send({ error: 'styles_or_wp_post_ids_required' });
  if (styles.length > 500 || wpPostIds.length > 500) return reply.code(400).send({ error: 'too_many_values', max: 500 });
  const rows = await db.listProductSaleQuantities({ styles, wpPostIds });
  return {
    sales: rows.map((row) => ({
      styleNo: row.style_no ?? null,
      wpPostId: row.wp_post_id == null ? null : String(row.wp_post_id),
      offerId: row.offer_id ?? null,
      saleQuantity: row.sale_quantity == null ? null : Number(row.sale_quantity),
      saleQuantityText: row.sale_quantity_text ?? null,
      shopName: row.shop_name ?? null,
      availability: row.availability_status ?? null,
      lastCrawledAt: row.last_crawled_at ?? null,
    })),
  };
});

// Product selection shortlist page (published products with sales/colour/size
// filters) for curating the portal catalog. Same HTTP Basic gate as /products.
app.get('/selection', { preHandler: requireDashboardAuth }, async (_request, reply) => {
  const html = await fs.readFile(new URL('../public/selection.html', import.meta.url), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

let selectionFacetsCache = null;
app.get('/api/selection/facets', { preHandler: requireDashboardOrApiKey }, async () => {
  const now = Date.now();
  if (selectionFacetsCache && now - selectionFacetsCache.at < 10 * 60_000) return selectionFacetsCache.value;
  const value = await db.listSelectionFacets();
  selectionFacetsCache = { at: now, value };
  return value;
});

// Currently-active product ids in the staging portal catalog, cached briefly so
// the selection page can show a truthful "published to portal" count/state.
let portalStagingActiveCache = { at: 0, ids: null, warning: null };
async function getPortalStagingActiveIds() {
  const now = Date.now();
  if (portalStagingActiveCache.ids && now - portalStagingActiveCache.at < 60_000) return portalStagingActiveCache;
  if (!config.portalStagingApiUrl || !config.portalStagingAdminSecret) {
    portalStagingActiveCache = { at: now, ids: null, warning: 'portal staging is not configured' };
    return portalStagingActiveCache;
  }
  try {
    const response = await fetch(new URL('/api/v1/admin/catalog', config.portalStagingApiUrl), {
      headers: { authorization: `Bearer ${config.portalStagingAdminSecret}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message ?? `Portal returned HTTP ${response.status}`);
    const ids = new Set((body?.products ?? []).map((product) => product.id));
    portalStagingActiveCache = { at: now, ids, warning: null };
  } catch (error) {
    portalStagingActiveCache = { at: now, ids: null, warning: String(error?.message || error) };
  }
  return portalStagingActiveCache;
}

/** Selection-page portal state; prefers the live staging catalog when available. */
function portalStateOf(row) {
  if (row.portal_error) return 'failed';
  if (!row.portal_product_id) return 'none';
  if (String(row.portal_status ?? '').toUpperCase() === 'ARCHIVED') return 'archived';
  if (row.portal_active === true) return 'published';
  if (row.portal_active === false) {
    // Not active in the staging catalog: removed there, or a historical
    // production publication that never belonged to staging.
    return row.portal_target === 'staging' ? 'archived' : 'published';
  }
  return 'published';
}

app.get('/api/selection/products', { preHandler: requireDashboardOrApiKey }, async (request) => {
  const staging = await getPortalStagingActiveIds();
  const result = await db.listSelectionProducts({
    q: request.query?.q,
    shopId: request.query?.shop,
    category1688: request.query?.category,
    categoryWp: request.query?.wpCategory,
    colorMin: request.query?.colorMin, colorMax: request.query?.colorMax,
    sizeMin: request.query?.sizeMin, sizeMax: request.query?.sizeMax,
    saleMin: request.query?.saleMin, monthlyMin: request.query?.monthlyMin,
    priceMin: request.query?.priceMin, priceMax: request.query?.priceMax,
    listedFrom: request.query?.listedFrom, listedTo: request.query?.listedTo,
    portal: request.query?.portal,
    sort: request.query?.sort, dir: request.query?.dir,
    limit: request.query?.limit, offset: request.query?.offset,
    portalActiveIds: staging.ids ? [...staging.ids] : null,
  });
  const coverUrl = (row) => {
    const parts = String(row.main_storage ?? '').split(/[\\/]/).filter(Boolean);
    const fileName = parts.pop() || '';
    let folder = parts.pop() || '';
    if (!/^[A-Za-z0-9._-]{1,180}$/.test(fileName) || fileName.includes('..')) return row.main_source_url ?? null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(folder)) folder = /^[A-Za-z0-9_-]{1,64}$/.test(String(row.offer_id ?? '')) ? String(row.offer_id) : '';
    if (!folder) return row.main_source_url ?? null;
    return `/api/product-images/${encodeURIComponent(folder)}/${encodeURIComponent(fileName)}?w=160`;
  };
  return {
    total: result.total, limit: result.limit, offset: result.offset,
    portalPublished: result.portalPublished ?? 0,
    portalCheck: staging.ids ? 'ok' : 'failed',
    portalWarning: staging.warning ?? null,
    items: result.items.map((row) => ({
      productDetailId: row.product_detail_id,
      offerId: row.offer_id,
      styleNo: row.style_no,
      wpPostId: row.wp_post_id === null || row.wp_post_id === undefined ? null : String(row.wp_post_id),
      wpUrl: row.wp_url ?? null,
      wpTitle: row.wp_title ?? null,
      wpCategory: row.wp_category ?? null,
      shopId: row.shop_id === null || row.shop_id === undefined ? null : String(row.shop_id),
      shopName: row.shop_name ?? null,
      category: row.shop_category ?? null,
      colorCount: row.color_count ?? 0,
      sizeCount: row.size_count ?? 0,
      colors: (Array.isArray(row.colors_json) ? row.colors_json : []).map((c) => c?.label ?? c?.code ?? c?.value ?? null).filter(Boolean),
      sizes: (Array.isArray(row.sizes_json) ? row.sizes_json : []).map((s) => s?.label ?? s?.value ?? null).filter(Boolean),
      saleQuantity: row.sale_quantity_float === null || row.sale_quantity_float === undefined ? null : Number(row.sale_quantity_float),
      thirtyBookCount: row.thirty_book_float === null || row.thirty_book_float === undefined ? null : Number(row.thirty_book_float),
      priceMin: row.price_min_float === null || row.price_min_float === undefined ? null : Number(row.price_min_float),
      priceMax: row.price_max_float === null || row.price_max_float === undefined ? null : Number(row.price_max_float),
      currency: row.currency ?? null,
      listingTime: row.listing_time ?? null,
      availability: row.availability_status ?? null,
      bundleKeeper: Boolean(row.is_bundle_keeper),
      portalActive: row.portal_active === null || row.portal_active === undefined ? null : Boolean(row.portal_active),
      portalState: portalStateOf(row),
      portalProductId: row.portal_product_id ?? null,
      portalStatus: row.portal_status ?? null,
      portalTarget: row.portal_target ?? null,
      portalSyncedAt: row.portal_synced_at ?? null,
      portalError: row.portal_error ?? null,
      cover: coverUrl(row),
    })),
  };
});

app.get('/api/selection/products/:id/media', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const media = await db.getSelectionProductMedia(request.params.id);
  if (!media) return reply.code(404).send({ error: 'not_found' });
  return {
    ...media,
    detailImages: (media.detailImages ?? []).map((image) => ({
      ...image,
      url: typeof image.url === 'string' && image.url.startsWith('/') ? `${config.publicBaseUrl}${image.url}` : image.url,
    })),
  };
});

// Portal-published products whose 1688 listing was delisted by a shop scan.
// The daily scan task reports these so the portal copy can be handled promptly.
app.get('/api/portal/delisted', { preHandler: requireDashboardOrApiKey }, async () => {
  const candidates = await db.listPortalDelistedProducts();
  let activeIds = null;
  let warning = null;
  if (config.portalStagingApiUrl && config.portalStagingAdminSecret) {
    try {
      const response = await fetch(new URL('/api/v1/admin/catalog', config.portalStagingApiUrl), {
        headers: { authorization: `Bearer ${config.portalStagingAdminSecret}` },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message ?? `Portal returned HTTP ${response.status}`);
      activeIds = new Set((body?.products ?? []).map((product) => product.id));
    } catch (error) {
      warning = String(error?.message || error);
    }
  } else {
    warning = 'portal staging is not configured';
  }
  const products = (activeIds ? candidates.filter((row) => activeIds.has(row.portal_product_id)) : candidates)
    .map((row) => ({
      styleNo: row.style_no,
      shopName: row.shop_name,
      portalProductId: row.portal_product_id,
      portalTarget: row.portal_target ?? null,
      portalStatus: row.portal_status ?? null,
      wpStatus: row.wp_status ?? null,
      delistedAt: row.delisted_at ?? null,
    }));
  return {
    checkedAt: new Date().toISOString(),
    portalCheck: activeIds ? 'ok' : 'failed',
    warning,
    checkedCount: candidates.length,
    products,
  };
});

app.get('/api/selection/products/:id/skus', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const data = await db.getSelectionProductSkus(request.params.id);
  if (!data) return reply.code(404).send({ error: 'not_found' });
  return data;
});

// Publish (or refresh) one selection product into the portal catalog, applying
// the chosen image set (visibility + order) to the portal product.
app.post('/api/selection/products/:id/portal-publish', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const productDetailId = Number(request.params.id);
  if (!Number.isInteger(productDetailId) || productDetailId <= 0) {
    return reply.code(400).send({ error: 'invalid_product_id' });
  }
  try {
    const result = await publishProductToPortal(productDetailId, {
      images: Array.isArray(request.body?.images) ? request.body.images : null,
      variantImages: Array.isArray(request.body?.variantImages) ? request.body.variantImages : null,
      target: request.body?.target === 'production' ? 'production' : 'staging',
    });
    portalStagingActiveCache = { at: 0, ids: null, warning: null };
    return {
      status: 'synced', productDetailId,
      portal: {
        productId: result.product?.id ?? null,
        status: result.product?.status ?? null,
        target: result.target ?? null,
        media: result.media,
        mediaCount: (result.product?.media ?? []).length,
        images: result.images ?? null,
        variantImages: result.variantImages ?? null,
        variantMatch: result.variantMatch ?? null,
      },
      publication: result.publication,
    };
  } catch (error) {
    const status = Number(error?.status) || 502;
    return reply.code(status).send({ error: error?.code || 'portal_publish_failed', message: String(error?.message || error) });
  }
});

// Remove (archive) one product from the staging portal catalog and mark the
// collector-side publication as archived; re-publishing restores it.
app.post('/api/selection/products/:id/portal-unpublish', { preHandler: requireDashboardOrApiKey }, async (request, reply) => {
  const productDetailId = Number(request.params.id);
  if (!Number.isInteger(productDetailId) || productDetailId <= 0) {
    return reply.code(400).send({ error: 'invalid_product_id' });
  }
  const publication = await db.getPortalPublication(productDetailId);
  if (!publication?.portal_product_id) {
    return reply.code(409).send({ error: 'portal_product_not_linked', message: '该产品没有已发布到 Portal 的记录' });
  }
  const target = publication.result?.target ?? null;
  if (target !== 'staging') {
    return reply.code(409).send({ error: 'portal_target_not_staging', message: '只有发布到 staging 的产品才能从这里移除' });
  }
  if (!config.portalStagingApiUrl || !config.portalStagingAdminSecret) {
    return reply.code(503).send({ error: 'portal_not_configured' });
  }
  try {
    const response = await fetch(new URL(`/api/v1/admin/catalog/${encodeURIComponent(publication.portal_product_id)}`, config.portalStagingApiUrl), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${config.portalStagingAdminSecret}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok && response.status !== 404) {
      const body = await response.json().catch(() => null);
      const message = body?.error?.message ?? `Portal returned HTTP ${response.status}`;
      return reply.code(502).send({ error: 'portal_unpublish_failed', message: String(message) });
    }
    await db.markPortalPublicationArchived(productDetailId);
    portalStagingActiveCache = { at: 0, ids: null, warning: null };
    return {
      status: 'archived',
      productDetailId,
      portalProductId: publication.portal_product_id,
      alreadyRemoved: response.status === 404,
    };
  } catch (error) {
    return reply.code(502).send({ error: 'portal_unpublish_failed', message: String(error?.message || error) });
  }
});

// Stock audit across published products: what each page claims (sample
// available vs made to order) against the SKU stock stored in its payload.
app.get('/api/wordpress/publications/stock-audit', { preHandler: requireDashboardOrApiKey }, async (request) => ({
  counts: await db.auditPublicationStock(),
  mismatches: await db.listSampleAvailabilityMismatches(request.query?.limit),
  samples: await db.samplePublicationStocks(request.query?.limit),
}));

// Recompute the sample-availability meta for published pages whose payload stock
// changed after the last sync (split/renumber runs). Deterministic, no model.
const stockRepairJobs = new Map();

app.post('/api/wordpress/publications/stock-audit/repair', { preHandler: requireApiKey }, async (_request, reply) => {
  if ([...stockRepairJobs.values()].some((job) => job.status === 'running')) {
    return reply.code(409).send({ error: 'stock_repair_already_running' });
  }
  const job = {
    id: crypto.randomUUID(), status: 'running', total: 0, repaired: 0, failed: 0,
    createdAt: new Date().toISOString(), completedAt: null, errors: [],
  };
  stockRepairJobs.set(job.id, job);
  trimTerminalJobs(stockRepairJobs);
  (async () => {
    try {
      const rows = await db.listSampleAvailabilityMismatches(500);
      job.total = rows.length;
      for (const row of rows) {
        try {
          const publication = await db.getWordPressPublication(row.product_detail_id);
          const payload = publication?.payload;
          if (!publication || !payload) { job.failed += 1; continue; }
          const skuRows = Array.isArray(payload.sku_matrix?.rows) ? payload.sku_matrix.rows : [];
          const inStock = skuRows.length > 0 && skuRows.every((sku) => {
            const value = sku?.source_stock;
            return value !== null && value !== undefined && value !== '' && Number(value) > 0;
          });
          payload.meta = {
            ...(payload.meta ?? {}),
            sample_available: inStock,
            sample_lead_time: inStock ? '3 working days' : '7 to 14 working days',
            lead_time: inStock ? '3 working days' : '7 to 14 working days',
          };
          await updateWordPressProductStyleNumber({
            publication, styleNo: publication.style_no, config,
            optionOverrides: await db.listProductOptionOverrides(row.product_detail_id),
          });
          const syncHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
          await db.saveWordPressPublication(row.product_detail_id, {
            translationId: publication.translation_id, externalId: publication.external_id,
            styleNo: publication.style_no, wpPostId: publication.wp_post_id, wpUrl: publication.wp_url,
            wpEditUrl: publication.wp_edit_url, wpStatus: publication.wp_status ?? 'publish',
            syncHash, payload, result: publication.result ?? {}, lastError: null,
          });
          job.repaired += 1;
        } catch (error) {
          job.failed += 1;
          job.errors.push({ productDetailId: row.product_detail_id, message: String(error?.message || error).slice(0, 160) });
        }
      }
      job.status = job.failed ? 'completed_with_errors' : 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = String(error?.message || error).slice(0, 200);
    } finally {
      job.completedAt = new Date().toISOString();
    }
  })();
  return reply.code(202).send(job);
});

app.get('/api/wordpress/stock-repair-jobs/:id', { preHandler: requireApiKey }, async (request, reply) => {
  const job = stockRepairJobs.get(request.params.id);
  return job ?? reply.code(404).send({ error: 'not_found' });
});

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

// Split siblings of a bundle are separate WordPress posts tracked in the saved
// split contents (not in product_wordpress_publications), so a bundle deletion
// must take its whole family down — keeper and siblings — or it stays
// half-published. The stored split-content statuses are updated to match.
async function unpublishSplitSiblingPosts(productDetailId, targetStatus) {
  const results = [];
  try {
    const contents = await db.getSplitContents(productDetailId);
    const family = (contents?.result?.products ?? [])
      .filter((product) => product?.wp?.postId
        && (product.wp.role === 'split' || product.wp.role === 'keeper'));
    if (!family.length) return results;
    const updates = [];
    for (const member of family) {
      try {
        await setWordPressProductStatus({ postId: member.wp.postId, status: targetStatus, config });
        updates.push({ productId: member.id, wp: { ...member.wp, status: targetStatus } });
        results.push({ postId: member.wp.postId, styleNo: member.wp.styleNo ?? null,
          role: member.wp.role, status: targetStatus });
      } catch (error) {
        results.push({ postId: member.wp.postId, styleNo: member.wp.styleNo ?? null,
          role: member.wp.role, error: String(error?.message || error).slice(0, 120) });
      }
    }
    if (updates.length) await db.mergeSplitContentWpResults(productDetailId, updates).catch(() => null);
  } catch { /* family cleanup is best effort */ }
  return results;
}

app.post('/api/product-details/:id/wordpress/unpublish', { preHandler: requireApiKey }, async (request, reply) => {
  const detail = await db.getProductDetail(request.params.id);
  if (!detail) return reply.code(404).send({ error: 'not_found' });
  const targetStatus = request.body?.status === 'private' ? 'private' : 'draft';
  const publication = await db.getWordPressPublication(detail.id);
  if (!publication?.wp_post_id) {
    const splitSiblings = await unpublishSplitSiblingPosts(detail.id, targetStatus);
    return { status: 'not_published', productDetailId: detail.id,
      ragDeactivationScheduled: false, splitSiblings };
  }
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
    const splitSiblings = await unpublishSplitSiblingPosts(detail.id, targetStatus);
    const rag = await scheduleProductRagSync(detail.id, { trigger: 'source_delisted' });
    return {
      status: 'unpublished', productDetailId: detail.id,
      wordpressStatus: saved.wp_status, ragDeactivationScheduled: rag.scheduled, splitSiblings,
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
  const limit = Math.min(Math.max(Number(request.body?.limit) || 48, 1), 48);
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
// image URLs come from the LinkFox capture data (raw_data.linkfox.raw
// .description); they are downloaded directly — no 1688 page visit, no
// browser. Files + product_detail_images rows stay with the collector and are
// intentionally not pushed to WordPress.
app.post('/api/product-details/:id/detail-images', { preHandler: requireApiKey }, async (request, reply) => {
  const detailId = Number(request.params.id);
  if (!Number.isInteger(detailId) || detailId <= 0) return reply.code(400).send({ error: 'invalid_detail_id' });
  const detail = await db.getProductDetail(detailId).catch(() => null);
  if (!detail) return reply.code(404).send({ error: 'not_found' });

  const id = crypto.randomUUID();
  const job = { id, status: 'queued', detailId, offerId: detail.offer_id ?? null,
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    downloaded: null, failed: null, imageCount: null, images: null, error: null };
  detailImageJobs.set(id, job);
  trimTerminalJobs(detailImageJobs);
  multimodalAuditQueue = multimodalAuditQueue.catch(() => {}).then(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      const result = await ensureDescriptionImages(detail);
      const fresh = await db.getProductDetail(detailId);
      const rows = (fresh?.images ?? [])
        .filter((image) => image.image_type === 'description')
        .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0));
      job.downloaded = result.downloaded;
      job.failed = result.failed;
      job.imageCount = rows.length;
      job.images = rows.map((image) => ({ sourceUrl: image.source_url ?? null,
        storagePath: image.storage_path ?? null, mimeType: image.mime_type ?? null,
        byteSize: image.byte_size ?? null, sortOrder: image.sort_order ?? 0 }));
      job.status = 'completed';
      job.error = rows.length ? null : 'The LinkFox capture has no description images for this product.';
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
        thumb: base ? `${base}?w=160` : (image.source || null),
        source: image.source || null };
    });
  const detailImages = images
    .filter((image) => image?.type === 'description')
    .map((image) => {
      const base = imagePublicPath(image.path);
      return { id: String(image.id),
        thumb: base ? `${base}?w=160` : (image.source || null),
        source: image.source || null };
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
    wpStatusSource: row.wp_status_source || null,
    wpStatusCheckedAt: row.wp_status_checked_at || null,
    portalProductId: row.portal_product_id ? String(row.portal_product_id) : null,
    portalStatus: row.portal_status || null,
    portalTarget: row.portal_target || null,
    portalError: row.portal_error || null,
    portalSyncedAt: row.portal_synced_at || null,
    cover: gallery.length ? gallery[0].thumb : null,
    gallery,
    detailImages,
    dims: dimOrder.map((name) => ({ name, options: dimMap.get(name) })),
  };
}

// Source-image helpers for the catalog row strip: dedupe keys ignore CDN
// re-encoding suffixes, and the LinkFox description HTML yields the original
// detail-image URLs even before they are downloaded.
function normalizedDetailImageKey(value) {
  return String(value ?? '').trim()
    .replace(/^http:/i, 'https:').replace(/[?#].*$/, '').replace(/_\.webp$/i, '')
    .replace(/_\d+x\d+[^/]*$/i, '');
}

function extractDescriptionImageUrls(html) {
  const urls = [];
  const seen = new Set();
  for (const match of String(html ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    let url = match[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https:\/\//i.test(url)) continue;
    const key = normalizedDetailImageKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
    if (urls.length >= 60) break;
  }
  return urls;
}

// Portal staging state for a catalog row, mirroring the selection page: the
// live staging catalog (60s cache) decides published-vs-removed; the stored
// record covers failures and archived entries.
function catalogPortalState(row, liveIds) {  if (row.portal_error) return 'failed';
  if (!row.portal_product_id) return 'none';
  if (String(row.portal_status ?? '').toUpperCase() === 'ARCHIVED') return 'archived';
  if (liveIds) {
    return liveIds.has(String(row.portal_product_id))
      ? 'published'
      : (row.portal_target === 'staging' ? 'archived' : 'published');
  }
  return 'published';
}

app.get('/api/product-catalog', { preHandler: requireDashboardOrApiKey }, async (request) => {
  const colorsRaw = String(request.query?.colors ?? '').trim();
  const colors = /^[0-6]$/.test(colorsRaw) ? Number(colorsRaw) : 0;
  const wp = ['publish', 'unpublished'].includes(String(request.query?.wp ?? '').trim())
    ? String(request.query.wp).trim() : '';
  const bundle = ['bundle', 'clear'].includes(String(request.query?.bundle ?? '').trim())
    ? String(request.query.bundle).trim() : '';
  const shop = String(request.query?.shop ?? '').trim().slice(0, 24);
  const [result, staging] = await Promise.all([
    db.listProductCatalog({
      limit: request.query?.limit ?? 100,
      offset: request.query?.offset ?? 0,
      search: request.query?.search ?? '',
      colors,
      wp,
      bundle,
      shop,
    }),
    getPortalStagingActiveIds(),
  ]);
  const liveIds = staging.ids ? new Set([...staging.ids].map(String)) : null;
  const items = result.items.map((row) => ({
    ...toProductCatalogItem(row),
    portalState: catalogPortalState(row, liveIds),
    portalLive: row.portal_product_id && liveIds ? liveIds.has(String(row.portal_product_id)) : null,
  }));
  // Merge the original description images from the LinkFox data so the row
  // strip shows every source image even before it has been downloaded. The
  // extracted URL list is persisted on first use, so later page loads read a
  // small array instead of the (large) raw description HTML.
  const idsNeedingRaw = items.filter((item) => !(item.detailImages ?? []).length)
    .map((item) => Number(item.id));
  if (idsNeedingRaw.length) {
    const sourcesById = await db.getLinkfoxDetailSources(idsNeedingRaw).catch(() => new Map());
    const persistUpdates = [];
    for (const item of items) {
      const source = sourcesById.get(Number(item.id));
      if (!source) continue;
      let urls = Array.isArray(source.urls) && source.urls.length ? source.urls : null;
      if (!urls && source.html) {
        const parsed = extractDescriptionImageUrls(source.html);
        if (parsed.length) {
          urls = parsed;
          persistUpdates.push(db.saveLinkfoxDetailImageUrls(Number(item.id), parsed).catch(() => {}));
        }
      }
      if (!urls || !urls.length) continue;
      const seen = new Set((item.detailImages ?? [])
        .map((image) => normalizedDetailImageKey(image.source || image.thumb)));
      for (const url of urls) {
        const key = normalizedDetailImageKey(url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        item.detailImages.push({ id: null, thumb: url, source: url });
        if (item.detailImages.length >= 60) break;
      }
    }
    if (persistUpdates.length) void Promise.all(persistUpdates);
  }
  return {
    count: result.filteredTotal, total: result.total,
    colorCounts: result.colorCounts,
    wpCounts: result.wpCounts,
    bundleCounts: result.bundleCounts,
    shopCounts: result.shopCounts,
    manualBundleCount: result.manualBundleCount,
    limit: result.limit, offset: result.offset,
    portalCheck: staging.ids ? 'ok' : 'failed',
    portalWarning: staging.warning ?? null,
    items,
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

app.post('/api/page-probe', { preHandler: [requireApiKey, requireCollectorMode] }, async (request, reply) => {
  const url = request.body?.url;
  if (typeof url !== 'string' || !isAllowed1688Url(url)) {
    return reply.code(400).send({ error: 'A valid HTTPS 1688 URL is required.' });
  }
  const job = await db.createJob(crypto.randomUUID(), url, {
    mode: 'page_probe',
    waitMs: Number.isInteger(request.body?.waitMs) ? request.body.waitMs : 8000,
    tryNext: request.body?.tryNext !== false,
  });
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
        const blockedOfferId = String(result.extractedData?.offerId ?? '').trim();
        if (blockedOfferId && await db.isOfferBlocked(blockedOfferId).catch(() => false)) {
          await cleanupRejectedProductImages(result.extractedData.localImages ?? []);
          result.extractedData.localImages = [];
          result.status = 'blocked_offer';
          result.error = null;
        } else {
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

// Periodic WordPress status reconcile: self-healing backstop for the pushed
// status events. Runs in-process; stale products only, batched REST reads.
const wpStatusReconcileTimer = setInterval(() => {
  runWordpressStatusReconcile().catch((error) =>
    app.log.error({ err: error }, 'wordpress status reconcile failed'));
}, config.wpStatusReconcileMinutes * 60_000);
wpStatusReconcileTimer.unref?.();
setTimeout(() => {
  runWordpressStatusReconcile().catch((error) =>
    app.log.error({ err: error }, 'initial wordpress status reconcile failed'));
}, 15_000).unref?.();
if (!config.wpStatusEventToken) {
  app.log.warn('WP_STATUS_EVENT_TOKEN is not configured; WordPress status push events will be rejected (reconcile still runs).');
}
const workers = [workerLoop('general', 0),
  ...Array.from({ length: config.detailCaptureConcurrency }, (_, index) =>
    workerLoop('product_detail', index + 1))];
Promise.all(workers).catch((error) => {
  app.log.fatal(error, 'worker stopped');
  process.exitCode = 1;
});
