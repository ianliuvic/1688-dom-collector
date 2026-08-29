import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.COLLECTOR_BASE_URL || 'https://collector.yiswim.cloud').replace(/\/$/, '');
const apiKey = process.env.COLLECTOR_API_KEY;
const shopId = process.env.SYNC_SHOP_ID;
const publishStatus = process.env.SYNC_PUBLISH_STATUS || 'publish';
const progressPath = process.env.SYNC_PROGRESS_PATH;
const pollMs = Math.max(Number(process.env.SYNC_POLL_MS) || 15000, 5000);
const resumeEnabled = !['0', 'false', 'no'].includes(String(process.env.SYNC_RESUME || 'true').toLowerCase());

if (!apiKey) throw new Error('COLLECTOR_API_KEY is required.');
if (!shopId) throw new Error('SYNC_SHOP_ID is required.');
if (!progressPath) throw new Error('SYNC_PROGRESS_PATH is required.');

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
    failed: items.filter((item) => item.stage === 'failed').length,
    inFlight: items.filter((item) => !['published', 'failed'].includes(item.stage)).length,
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
  item.stage = 'capturing';
  item.error = null;
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
      try {
        await queueCapture(item);
      } catch (error) {
        if (!isTransientError(error)) failItem(item, 'capture', error);
      }
      return;
    }

    if (item.stage === 'capturing') {
      const job = await api(`/api/jobs/${item.captureJobId}`);
      if (['queued', 'running'].includes(job.status)) return;
      if (job.status !== 'completed') {
        failItem(item, 'capture', new Error(job.error || `Capture ended with ${job.status}.`));
        return;
      }
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
      await queueCapture(item).catch((error) => failItem(item, 'capture', error));
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
  const products = await api(`/api/shops/${encodeURIComponent(shopId)}/products?limit=1000`);
  const usable = (Array.isArray(products) ? products : [])
    .filter((product) => /^\d{10,13}$/.test(String(product.offer_id)));
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
      completedAt: null,
    } ])),
  };
  await saveProgress();
  for (const item of Object.values(progress.items)) {
    await queueCapture(item).catch((error) => failItem(item, 'capture', error));
  }
  await saveProgress();
  logProgress('All first-pass product detail jobs have been queued.');
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

  for (const item of Object.values(progress.items)) recoverExistingItem(item);

  // Captures are durable, but a prior network failure may have hidden the
  // completed response. Resolve SQL first and only enqueue a new capture if
  // no saved detail exists.
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'new')) {
    try {
      await resolveDetail(item);
    } catch {
      await queueCapture(item).catch((error) => {
        if (!isTransientError(error)) failItem(item, 'capture', error);
      });
    }
  }

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
    const active = Object.values(progress.items).filter((item) => !['published', 'failed'].includes(item.stage));
    await Promise.all(active.map((item) => advanceItem(item)));
    await saveProgress();

    const terminal = progress.counts.published + progress.counts.failed;
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
