import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.COLLECTOR_BASE_URL || 'https://collector.yiswim.cloud').replace(/\/$/, '');
const apiKey = process.env.COLLECTOR_API_KEY;
const syncProgressPath = process.env.SYNC_PROGRESS_PATH;
const repairProgressPath = process.env.GALLERY_REPAIR_PROGRESS_PATH;
const pollMs = Math.max(Number(process.env.GALLERY_REPAIR_POLL_MS) || 15000, 5000);

if (!apiKey) throw new Error('COLLECTOR_API_KEY is required.');
if (!syncProgressPath) throw new Error('SYNC_PROGRESS_PATH is required.');
if (!repairProgressPath) throw new Error('GALLERY_REPAIR_PROGRESS_PATH is required.');

let progress;
let stopping = false;

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransient(error) {
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(error?.statusCode))) return true;
  return /fetch failed|network|timeout|timed out|econnreset|socket hang up/i.test(String(error?.message || error));
}

async function api(endpoint, options = {}, attempt = 1) {
  try {
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
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 500) }; }
    if (!response.ok) {
      const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (attempt < 4 && isTransient(error)) {
      await sleep(attempt * 2000);
      return api(endpoint, options, attempt + 1);
    }
    throw error;
  }
}

function productImageCount(detail) {
  return (detail?.images ?? []).filter((image) => ['main', 'gallery'].includes(image.image_type)).length;
}

async function saveProgress() {
  const items = Object.values(progress.items);
  progress.updatedAt = now();
  progress.counts = {
    total: items.length,
    recaptureRequired: items.filter((item) => item.recaptureRequired).length,
    recaptured: items.filter((item) => item.recaptureStatus === 'completed').length,
    waitingForMainPublish: items.filter((item) => item.stage === 'waiting_for_main_publish').length,
    aligned: items.filter((item) => item.stage === 'aligned').length,
    republished: items.filter((item) => item.stage === 'republished').length,
    failed: items.filter((item) => item.stage === 'failed').length,
  };
  await fs.mkdir(path.dirname(repairProgressPath), { recursive: true });
  const temp = `${repairProgressPath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(progress, null, 2), 'utf8');
  await fs.rename(temp, repairProgressPath);
}

async function initialize() {
  const sync = JSON.parse(await fs.readFile(syncProgressPath, 'utf8'));
  const items = {};
  for (const source of Object.values(sync.items)) {
    if (!source.detailId) continue;
    const detail = await api(`/api/product-details/${source.detailId}`);
    const count = productImageCount(detail);
    items[source.offerId] = {
      offerId: source.offerId,
      detailId: String(source.detailId),
      beforeImageCount: count,
      afterImageCount: count,
      recaptureRequired: count <= 1,
      recaptureJobId: null,
      recaptureStatus: count <= 1 ? 'pending' : 'not_required',
      wordpressJobId: null,
      stage: count <= 1 ? 'recapture_pending' : 'waiting_for_main_publish',
      error: null,
    };
  }
  progress = {
    schemaVersion: 1,
    status: 'running',
    startedAt: now(),
    updatedAt: now(),
    completedAt: null,
    counts: {},
    items,
  };
  await saveProgress();
}

async function queueRecaptures() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'recapture_pending')) {
    try {
      const job = await api('/api/product-details', {
        method: 'POST',
        body: JSON.stringify({ offerId: item.offerId }),
      });
      item.recaptureJobId = job.id;
      item.recaptureStatus = 'queued';
      item.stage = 'recapturing';
    } catch (error) {
      item.stage = 'failed';
      item.error = error.message;
    }
  }
  await saveProgress();
}

async function advanceRecaptures() {
  const active = Object.values(progress.items).filter((item) => item.stage === 'recapturing');
  await Promise.all(active.map(async (item) => {
    try {
      const job = await api(`/api/jobs/${item.recaptureJobId}`);
      if (['queued', 'running'].includes(job.status)) return;
      if (job.status !== 'completed') throw new Error(job.error || `Recapture ended with ${job.status}.`);
      const detail = await api(`/api/product-details/${item.detailId}`);
      item.afterImageCount = productImageCount(detail);
      item.recaptureStatus = 'completed';
      item.stage = 'waiting_for_main_publish';
    } catch (error) {
      if (error.statusCode === 404) {
        item.wordpressJobId = null;
        item.stage = 'waiting_for_main_publish';
        return;
      }
      if (isTransient(error)) return;
      item.stage = 'failed';
      item.error = error.message;
    }
  }));
}

async function advanceWordPressRepairs() {
  const sync = JSON.parse(await fs.readFile(syncProgressPath, 'utf8'));
  const candidates = Object.values(progress.items).filter((item) => item.stage === 'waiting_for_main_publish');
  for (const item of candidates) {
    if (sync.items?.[item.offerId]?.stage !== 'published') continue;
    try {
      const [detail, publication] = await Promise.all([
        api(`/api/product-details/${item.detailId}`),
        api(`/api/product-details/${item.detailId}/wordpress`),
      ]);
      const expected = productImageCount(detail);
      const actual = Array.isArray(publication?.payload?.images) ? publication.payload.images.length : 0;
      item.afterImageCount = expected;
      item.wordpressImageCountBefore = actual;
      if (actual >= expected) {
        item.stage = 'aligned';
        continue;
      }
      const job = await api(`/api/product-details/${item.detailId}/wordpress/publish`, {
        method: 'POST',
        body: JSON.stringify({ status: 'publish', categoryMode: 'auto', tagMode: 'auto' }),
      });
      item.wordpressJobId = job.id;
      item.stage = 'republishing';
    } catch (error) {
      if (isTransient(error)) continue;
      item.stage = 'failed';
      item.error = error.message;
    }
  }

  const active = Object.values(progress.items).filter((item) => item.stage === 'republishing');
  await Promise.all(active.map(async (item) => {
    try {
      const job = await api(`/api/wordpress-jobs/${item.wordpressJobId}`);
      if (['queued', 'running'].includes(job.status)) return;
      if (job.status !== 'completed') throw new Error(job.error || `Republish ended with ${job.status}.`);
      const publication = await api(`/api/product-details/${item.detailId}/wordpress`);
      item.wordpressImageCountAfter = Array.isArray(publication?.payload?.images)
        ? publication.payload.images.length : 0;
      item.stage = item.wordpressImageCountAfter >= item.afterImageCount ? 'republished' : 'failed';
      if (item.stage === 'failed') item.error = 'WordPress image count is still incomplete after republish.';
    } catch (error) {
      if (isTransient(error)) return;
      item.stage = 'failed';
      item.error = error.message;
    }
  }));
}

async function main() {
  try {
    progress = JSON.parse(await fs.readFile(repairProgressPath, 'utf8'));
    progress.status = 'running';
    progress.completedAt = null;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await initialize();
  }
  await queueRecaptures();
  let lastLogAt = 0;
  while (!stopping) {
    await advanceRecaptures();
    await advanceWordPressRepairs();
    await saveProgress();
    const terminal = progress.counts.aligned + progress.counts.republished + progress.counts.failed;
    if (terminal === progress.counts.total) {
      progress.status = progress.counts.failed ? 'completed_with_errors' : 'completed';
      progress.completedAt = now();
      await saveProgress();
      console.log(JSON.stringify({ at: now(), message: 'Gallery repair finished.', counts: progress.counts }));
      return;
    }
    if (Date.now() - lastLogAt >= 60000) {
      console.log(JSON.stringify({ at: now(), message: 'Gallery repair is running.', counts: progress.counts }));
      lastLogAt = Date.now();
    }
    await sleep(pollMs);
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
    await saveProgress().catch(() => {});
  }
  console.error(JSON.stringify({ at: now(), status: 'failed', error: error.message }));
  process.exit(1);
});
