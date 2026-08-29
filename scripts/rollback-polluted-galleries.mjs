import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.COLLECTOR_BASE_URL || 'https://collector.yiswim.cloud').replace(/\/$/, '');
const apiKey = process.env.COLLECTOR_API_KEY;
const sourceProgressPath = process.env.GALLERY_REPAIR_PROGRESS_PATH;
const rollbackProgressPath = process.env.GALLERY_ROLLBACK_PROGRESS_PATH;
const pollMs = Math.max(Number(process.env.GALLERY_ROLLBACK_POLL_MS) || 10000, 5000);

if (!apiKey || !sourceProgressPath || !rollbackProgressPath) {
  throw new Error('COLLECTOR_API_KEY, GALLERY_REPAIR_PROGRESS_PATH and GALLERY_ROLLBACK_PROGRESS_PATH are required.');
}

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let progress;
let stopping = false;

function transient(error) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.statusCode))
    || /fetch failed|network|timeout|econnreset/i.test(String(error?.message || error));
}

async function api(endpoint, options = {}, attempt = 1) {
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      ...options,
      headers: { authorization: `Bearer ${apiKey}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
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
    if (attempt < 4 && transient(error)) {
      await sleep(attempt * 1500);
      return api(endpoint, options, attempt + 1);
    }
    throw error;
  }
}

function imageCount(detail) {
  return (detail?.images ?? []).filter((image) => ['main', 'gallery'].includes(image.image_type)).length;
}

async function save() {
  const items = Object.values(progress.items);
  progress.updatedAt = now();
  progress.counts = {
    total: items.length,
    recaptured: items.filter((item) => ['ready_to_republish', 'republishing', 'completed'].includes(item.stage)).length,
    corrected: items.filter((item) => item.stage === 'completed').length,
    failed: items.filter((item) => item.stage === 'failed').length,
  };
  await fs.mkdir(path.dirname(rollbackProgressPath), { recursive: true });
  const temp = `${rollbackProgressPath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(progress, null, 2), 'utf8');
  await fs.rename(temp, rollbackProgressPath);
}

async function initialize() {
  const source = JSON.parse(await fs.readFile(sourceProgressPath, 'utf8'));
  const affected = Object.values(source.items)
    .filter((item) => item.recaptureRequired)
    .sort((a, b) => Number(['republished', 'republishing'].includes(b.stage))
      - Number(['republished', 'republishing'].includes(a.stage)));
  progress = {
    schemaVersion: 1,
    status: 'running',
    startedAt: now(),
    updatedAt: now(),
    completedAt: null,
    counts: {},
    items: Object.fromEntries(affected.map((item) => [item.offerId, {
      offerId: item.offerId,
      detailId: String(item.detailId),
      captureJobId: null,
      wordpressJobId: null,
      restoredImageCount: null,
      wordpressImageCount: null,
      stage: 'pending',
      error: null,
    }])),
  };
  await save();
}

async function queueCaptures() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'pending')) {
    try {
      const job = await api('/api/product-details', {
        method: 'POST', body: JSON.stringify({ offerId: item.offerId }),
      });
      item.captureJobId = job.id;
      item.stage = 'recapturing';
    } catch (error) {
      item.stage = 'failed';
      item.error = error.message;
    }
  }
  await save();
}

async function advance() {
  for (const item of Object.values(progress.items)) {
    try {
      if (item.stage === 'recapturing') {
        const job = await api(`/api/jobs/${item.captureJobId}`);
        if (['queued', 'running'].includes(job.status)) continue;
        if (job.status !== 'completed') throw new Error(job.error || `Capture ended with ${job.status}.`);
        const detail = await api(`/api/product-details/${item.detailId}`);
        item.restoredImageCount = imageCount(detail);
        item.stage = 'ready_to_republish';
      }
      if (item.stage === 'ready_to_republish') {
        try {
          const job = await api(`/api/product-details/${item.detailId}/wordpress/publish`, {
            method: 'POST',
            body: JSON.stringify({ status: 'publish', categoryMode: 'auto', tagMode: 'auto' }),
          });
          item.wordpressJobId = job.id;
          item.stage = 'republishing';
        } catch (error) {
          if (error.statusCode === 409 || transient(error)) continue;
          throw error;
        }
      }
      if (item.stage === 'republishing') {
        const job = await api(`/api/wordpress-jobs/${item.wordpressJobId}`);
        if (['queued', 'running'].includes(job.status)) continue;
        if (job.status !== 'completed') throw new Error(job.error || `Republish ended with ${job.status}.`);
        const publication = await api(`/api/product-details/${item.detailId}/wordpress`);
        item.wordpressImageCount = Array.isArray(publication?.payload?.images)
          ? publication.payload.images.length : 0;
        item.stage = 'completed';
      }
    } catch (error) {
      if (error.statusCode === 404 && item.stage === 'republishing') {
        item.wordpressJobId = null;
        item.stage = 'ready_to_republish';
      } else if (!transient(error)) {
        item.stage = 'failed';
        item.error = error.message;
      }
    }
  }
}

async function main() {
  try {
    progress = JSON.parse(await fs.readFile(rollbackProgressPath, 'utf8'));
    progress.status = 'running';
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await initialize();
  }
  await queueCaptures();
  let lastLog = 0;
  while (!stopping) {
    await advance();
    await save();
    if (progress.counts.corrected + progress.counts.failed === progress.counts.total) {
      progress.status = progress.counts.failed ? 'completed_with_errors' : 'completed';
      progress.completedAt = now();
      await save();
      console.log(JSON.stringify({ at: now(), message: 'Polluted Gallery rollback finished.', counts: progress.counts }));
      return;
    }
    if (Date.now() - lastLog > 60000) {
      console.log(JSON.stringify({ at: now(), message: 'Polluted Gallery rollback is running.', counts: progress.counts }));
      lastLog = Date.now();
    }
    await sleep(pollMs);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    stopping = true;
    if (progress) {
      progress.status = 'interrupted';
      await save().catch(() => {});
    }
    process.exit(0);
  });
}

main().catch(async (error) => {
  if (progress) {
    progress.status = 'failed';
    progress.fatalError = error.message;
    await save().catch(() => {});
  }
  console.error(JSON.stringify({ at: now(), status: 'failed', error: error.message }));
  process.exit(1);
});
