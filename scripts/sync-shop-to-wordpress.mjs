import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.COLLECTOR_BASE_URL || 'https://collector.yiswim.cloud').replace(/\/$/, '');
const apiKey = process.env.COLLECTOR_API_KEY;
const shopId = process.env.SYNC_SHOP_ID;
const publishStatus = process.env.SYNC_PUBLISH_STATUS || 'publish';
const progressPath = process.env.SYNC_PROGRESS_PATH;
const pollMs = Math.max(Number(process.env.SYNC_POLL_MS) || 15000, 5000);
const resumeEnabled = !['0', 'false', 'no'].includes(String(process.env.SYNC_RESUME || 'true').toLowerCase());
const minListingDateText = process.env.SYNC_MIN_LISTING_DATE || '';
const minListingDate = minListingDateText ? new Date(minListingDateText) : null;
const captureMinConcurrency = Math.min(Math.max(Number(process.env.SYNC_CAPTURE_MIN_CONCURRENCY) || 2, 1), 5);
const captureMaxConcurrency = Math.min(Math.max(Number(process.env.SYNC_CAPTURE_MAX_CONCURRENCY) || 5,
  captureMinConcurrency), 5);

if (!apiKey) throw new Error('COLLECTOR_API_KEY is required.');
if (!shopId) throw new Error('SYNC_SHOP_ID is required.');
if (!progressPath) throw new Error('SYNC_PROGRESS_PATH is required.');
if (minListingDate && Number.isNaN(minListingDate.getTime())) throw new Error('SYNC_MIN_LISTING_DATE is invalid.');

let progress;
let stopping = false;

function now() {
  return new Date().toISOString();
}

async function api(endpoint, options = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs || 120000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
    error.statusCode = response.status;
    error.response = body;
    throw error;
  }
  return body;
}

async function saveProgress() {
  progress.updatedAt = now();
  const items = Object.values(progress.items);
  progress.counts = {
    total: items.length,
    captureQueued: items.filter((item) => item.captureJobId).length,
    captured: items.filter((item) => item.detailId).length,
    translated: items.filter((item) => item.translationCompleted).length,
    published: items.filter((item) => item.stage === 'published').length,
    duplicateRejected: items.filter((item) => item.stage === 'duplicate_rejected').length,
    failed: items.filter((item) => item.stage === 'failed').length,
    inFlight: items.filter((item) => !['published', 'duplicate_rejected', 'failed'].includes(item.stage)).length,
  };
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  const tempPath = `${progressPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(progress, null, 2), 'utf8');
  await fs.rename(tempPath, progressPath);
}

function logProgress(message) {
  const counts = progress.counts || {};
  console.log(JSON.stringify({ at: now(), message, pass: progress.pass, status: progress.status, counts }));
}

function failItem(item, stage, error) {
  item.stage = 'failed';
  item.failedStage = stage;
  item.error = error?.message || String(error);
  item.lastFailedAt = now();
}

function isTransientError(error) {
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(error?.statusCode))) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return [
    'fetch failed',
    'gateway time-out',
    'gateway timeout',
    'timed out',
    'timeout',
    'econnreset',
    'econnrefused',
    'socket hang up',
    'network',
  ].some((fragment) => message.includes(fragment));
}

function resetLostJob(item, stage) {
  item.error = null;
  item.failedStage = null;
  if (stage === 'translation') {
    item.translationJobId = null;
    item.translationCompleted = false;
    item.stage = 'captured';
  } else if (stage === 'publish') {
    item.wordpressJobId = null;
    item.stage = 'translated';
  }
}

function recoverExistingItem(item) {
  // Published products are immutable checkpoints. Everything else can safely
  // be rebuilt because translations are versioned and WordPress upserts by
  // the external product identity.
  if (item.stage === 'published') return;

  const errorText = String(item.error || '').toLowerCase();
  const recoverableFailure = item.stage === 'failed' && (
    errorText.includes('not_found')
    || errorText.includes('fetch failed')
    || errorText.includes('gateway time-out')
    || errorText.includes('gateway timeout')
    || errorText.includes('timeout')
    || errorText.includes('network')
  );

  if (recoverableFailure) {
    if (item.failedStage === 'capture') {
      item.stage = item.detailId ? 'captured' : 'new';
      if (!item.detailId) item.captureJobId = null;
    } else if (item.failedStage === 'translation') {
      resetLostJob(item, 'translation');
    } else if (item.failedStage === 'publish') {
      resetLostJob(item, 'publish');
    }
    item.error = null;
    item.failedStage = null;
  }
}

async function queueCapture(item) {
  const job = await api('/api/product-details', {
    method: 'POST',
    body: JSON.stringify({ offerId: item.offerId }),
  });
  item.captureJobId = job.id;
  item.captureAttempts += 1;
  item.captureQueuedAt = now();
  item.stage = 'capturing';
  item.error = null;
}

function recordCaptureOutcome(item, success, status) {
  const started = Date.parse(item.captureQueuedAt || '') || Date.now();
  const durationMs = Math.max(0, Date.now() - started);
  const adaptive = progress.adaptiveCapture;
  adaptive.recentOutcomes.push({ at: now(), success, status, durationMs });
  adaptive.recentOutcomes = adaptive.recentOutcomes.slice(-10);
  adaptive.completedSinceAdjustment += 1;
  if (adaptive.completedSinceAdjustment < 3) return;
  adaptive.completedSinceAdjustment = 0;
  const recent = adaptive.recentOutcomes.slice(-5);
  const failureRate = recent.filter((entry) => !entry.success).length / recent.length;
  const averageMs = recent.reduce((sum, entry) => sum + entry.durationMs, 0) / recent.length;
  const previous = adaptive.currentConcurrency;
  if ((failureRate >= 0.2 || averageMs > 180000) && previous > captureMinConcurrency) {
    adaptive.currentConcurrency -= 1;
  } else if (recent.length >= 3 && failureRate === 0 && averageMs <= 120000
      && previous < captureMaxConcurrency) {
    adaptive.currentConcurrency += 1;
  }
  if (adaptive.currentConcurrency !== previous) {
    adaptive.adjustments.push({ at: now(), from: previous, to: adaptive.currentConcurrency,
      failureRate, averageMs: Math.round(averageMs) });
  }
}

async function fillCaptureSlots() {
  const inFlight = Object.values(progress.items).filter((item) => item.stage === 'capturing').length;
  const available = Math.max(0, progress.adaptiveCapture.currentConcurrency - inFlight);
  const pending = Object.values(progress.items).filter((item) => item.stage === 'new').slice(0, available);
  for (const item of pending) {
    await queueCapture(item).catch((error) => {
      if (!isTransientError(error)) failItem(item, 'capture', error);
    });
  }
}

async function resolveDetail(item) {
  const details = await api(`/api/product-details?offerId=${encodeURIComponent(item.offerId)}&limit=10`);
  const detail = Array.isArray(details) ? details[0] : null;
  if (!detail?.id) throw new Error('Captured product detail could not be resolved.');
  item.detailId = String(detail.id);
  item.stage = 'captured';
}

async function queueTranslation(item) {
  const job = await api(`/api/product-details/${item.detailId}/translations`, {
    method: 'POST',
    body: JSON.stringify({ targetLanguage: 'en' }),
  });
  item.translationJobId = job.id;
  item.translationAttempts += 1;
  item.stage = 'translating';
  item.error = null;
}

async function queuePublish(item) {
  const job = await api(`/api/product-details/${item.detailId}/wordpress/publish`, {
    method: 'POST',
    body: JSON.stringify({
      status: publishStatus,
      categoryMode: 'auto',
      tagMode: 'auto',
    }),
  });
  item.wordpressJobId = job.id;
  item.publishAttempts += 1;
  item.stage = 'publishing';
  item.error = null;
}

async function advanceItem(item) {
  try {
    if (item.stage === 'new') {
      return;
    }

    if (item.stage === 'capturing') {
      const job = await api(`/api/jobs/${item.captureJobId}`);
      if (['queued', 'running'].includes(job.status)) return;
      if (job.status === 'rejected_duplicate') {
        recordCaptureOutcome(item, true, job.status);
        item.stage = 'duplicate_rejected';
        item.duplicateAnalysis = job.extracted_data?.duplicateAnalysis || null;
        item.completedAt = now();
        item.error = null;
        return;
      }
      if (job.status !== 'completed') {
        recordCaptureOutcome(item, false, job.status);
        failItem(item, 'capture', new Error(job.error || `Capture ended with ${job.status}.`));
        return;
      }
      recordCaptureOutcome(item, true, job.status);
      await resolveDetail(item);
    }

    if (item.stage === 'captured') {
      try {
        await queueTranslation(item);
      } catch (error) {
        if (!isTransientError(error)) failItem(item, 'translation', error);
      }
      return;
    }

    if (item.stage === 'translating') {
      const job = await api(`/api/translation-jobs/${item.translationJobId}`);
      if (['queued', 'running'].includes(job.status)) return;
      if (job.status !== 'completed') {
        failItem(item, 'translation', new Error(job.error || `Translation ended with ${job.status}.`));
        return;
      }
      item.translationCompleted = true;
      item.stage = 'translated';
    }

    if (item.stage === 'translated') {
      try {
        await queuePublish(item);
      } catch (error) {
        if (!isTransientError(error)) failItem(item, 'publish', error);
      }
      return;
    }

    if (item.stage === 'publishing') {
      const job = await api(`/api/wordpress-jobs/${item.wordpressJobId}`);
      if (['queued', 'running'].includes(job.status)) return;
      if (job.status !== 'completed') {
        failItem(item, 'publish', new Error(job.error || `Publishing ended with ${job.status}.`));
        return;
      }
      item.stage = 'published';
      item.wordpressPostId = job.result?.wordpress_post_id || job.result?.postId || null;
      item.wordpressUrl = job.result?.wordpress_url || job.result?.url || null;
      item.completedAt = now();
      item.error = null;
    }
  } catch (error) {
    const stage = item.stage === 'capturing' ? 'capture'
      : item.stage === 'translating' ? 'translation'
        : item.stage === 'publishing' ? 'publish' : item.stage;
    if (error.statusCode === 404 && stage === 'capture') {
      try {
        await resolveDetail(item);
      } catch {
        item.captureJobId = null;
        item.stage = 'new';
      }
      return;
    }
    if (error.statusCode === 404 && ['translation', 'publish'].includes(stage)) {
      resetLostJob(item, stage);
      return;
    }
    if (isTransientError(error)) return;
    failItem(item, stage, error);
  }
}

async function beginRetryPass() {
  progress.pass = 2;
  progress.retryStartedAt = now();
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'failed')) {
    item.error = null;
    if (item.failedStage === 'capture') {
      item.captureJobId = null;
      item.detailId = null;
      item.translationJobId = null;
      item.translationCompleted = false;
      item.wordpressJobId = null;
      item.stage = 'new';
    } else if (item.failedStage === 'translation') {
      item.translationJobId = null;
      item.translationCompleted = false;
      item.wordpressJobId = null;
      item.stage = 'captured';
      await queueTranslation(item).catch((error) => failItem(item, 'translation', error));
    } else {
      item.wordpressJobId = null;
      item.stage = 'translated';
      await queuePublish(item).catch((error) => failItem(item, 'publish', error));
    }
  }
}

async function initialize() {
  const products = await api(`/api/shops/${encodeURIComponent(shopId)}/products?limit=5000`);
  const usable = (Array.isArray(products) ? products : [])
    .filter((product) => /^\d{10,13}$/.test(String(product.offer_id)))
    .filter((product) => !minListingDate || (product.listing_time
      && new Date(product.listing_time).getTime() > minListingDate.getTime()));
  const allProducts = Array.isArray(products) ? products : [];
  progress = {
    schemaVersion: 1,
    shopId: String(shopId),
    sourceShopUrl: process.env.SYNC_SHOP_URL || null,
    publishStatus,
    status: 'running',
    pass: 1,
    startedAt: now(),
    updatedAt: now(),
    completedAt: null,
    selection: {
      fetched: allProducts.length,
      minListingDate: minListingDate?.toISOString() || null,
      selected: usable.length,
      excludedByDateOrMissingDate: allProducts.length - usable.length,
    },
    adaptiveCapture: {
      minConcurrency: captureMinConcurrency,
      maxConcurrency: captureMaxConcurrency,
      currentConcurrency: captureMinConcurrency,
      completedSinceAdjustment: 0,
      recentOutcomes: [],
      adjustments: [],
    },
    counts: {},
    items: Object.fromEntries(usable.map((product) => [String(product.offer_id), {
      offerId: String(product.offer_id),
      sourceUrl: product.product_url || `https://detail.1688.com/offer/${product.offer_id}.html`,
      stage: 'new',
      captureJobId: null,
      detailId: null,
      translationJobId: null,
      translationCompleted: false,
      wordpressJobId: null,
      wordpressPostId: null,
      wordpressUrl: null,
      captureAttempts: 0,
      translationAttempts: 0,
      publishAttempts: 0,
      failedStage: null,
      error: null,
      listingTime: product.listing_time || null,
      captureQueuedAt: null,
      completedAt: null,
    } ])),
  };
  await saveProgress();
  await fillCaptureSlots();
  await saveProgress();
  logProgress('The dated product set is ready and adaptive detail capture has started.');
}

async function resume() {
  const raw = await fs.readFile(progressPath, 'utf8');
  const existing = JSON.parse(raw);
  if (String(existing.shopId) !== String(shopId)) {
    throw new Error(`Progress shop ${existing.shopId} does not match requested shop ${shopId}.`);
  }
  progress = existing;
  progress.status = 'running';
  progress.completedAt = null;
  progress.fatalError = null;
  progress.adaptiveCapture ||= {
    minConcurrency: captureMinConcurrency, maxConcurrency: captureMaxConcurrency,
    currentConcurrency: captureMinConcurrency, completedSinceAdjustment: 0,
    recentOutcomes: [], adjustments: [],
  };

  for (const item of Object.values(progress.items)) recoverExistingItem(item);

  // Captures are durable, but a prior network failure may have hidden the
  // completed response. Resolve SQL first and only enqueue a new capture if
  // no saved detail exists.
  // Only reconcile items that had previously reached the capture API. Fresh,
  // never-admitted items cannot already exist because of this run, and
  // querying every one of them makes a large-shop resume needlessly slow.
  for (const item of Object.values(progress.items)
    .filter((entry) => entry.stage === 'new' && Number(entry.captureAttempts || 0) > 0)) {
    try {
      await resolveDetail(item);
    } catch { /* New items are admitted later by the adaptive capture window. */ }
  }

  await fillCaptureSlots();
  await saveProgress();
  logProgress('Existing synchronization progress was recovered.');
}

async function main() {
  let resumed = false;
  if (resumeEnabled) {
    try {
      await fs.access(progressPath);
      await resume();
      resumed = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!resumed) await initialize();
  let lastLogAt = 0;
  while (!stopping) {
    await fillCaptureSlots();
    const active = Object.values(progress.items)
      .filter((item) => !['new', 'published', 'duplicate_rejected', 'failed'].includes(item.stage));
    await Promise.all(active.map((item) => advanceItem(item)));
    await fillCaptureSlots();
    await saveProgress();

    const terminal = progress.counts.published + progress.counts.duplicateRejected + progress.counts.failed;
    if (terminal === progress.counts.total) {
      if (progress.pass === 1 && progress.counts.failed > 0) {
        await beginRetryPass();
        await saveProgress();
        logProgress('First pass finished; failed items were queued for one retry pass.');
      } else {
        progress.status = progress.counts.failed > 0 ? 'completed_with_errors' : 'completed';
        progress.completedAt = now();
        await saveProgress();
        logProgress('Shop synchronization finished.');
        return;
      }
    }

    if (Date.now() - lastLogAt >= 60000) {
      logProgress('Shop synchronization is running.');
      lastLogAt = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopping = true;
    if (progress) {
      progress.status = 'interrupted';
      await saveProgress().catch(() => {});
    }
    process.exit(0);
  });
}

main().catch(async (error) => {
  if (progress) {
    progress.status = 'failed';
    progress.fatalError = error.message;
    progress.completedAt = now();
    await saveProgress().catch(() => {});
  }
  console.error(JSON.stringify({ at: now(), status: 'failed', error: error.message }));
  process.exit(1);
});
