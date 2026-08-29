import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.COLLECTOR_BASE_URL || 'https://collector.yiswim.cloud').replace(/\/$/, '');
const apiKey = process.env.COLLECTOR_API_KEY;
const syncProgressPath = process.env.SYNC_PROGRESS_PATH;
const progressPath = process.env.GALLERY_SANITIZE_PROGRESS_PATH;
const pollMs = Math.max(Number(process.env.GALLERY_SANITIZE_POLL_MS) || 10000, 5000);

if (!apiKey || !syncProgressPath || !progressPath) throw new Error('Required Gallery sanitize environment is missing.');

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

async function save() {
  const items = Object.values(progress.items);
  progress.updatedAt = now();
  progress.counts = {
    total: items.length,
    queued: items.filter((item) => item.stage === 'queued').length,
    corrected: items.filter((item) => item.stage === 'completed').length,
    failed: items.filter((item) => item.stage === 'failed').length,
  };
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  const temp = `${progressPath}.tmp`;
  await fs.writeFile(temp, JSON.stringify(progress, null, 2), 'utf8');
  await fs.rename(temp, progressPath);
}

async function initialize() {
  const sync = JSON.parse(await fs.readFile(syncProgressPath, 'utf8'));
  const items = {};
  for (const source of Object.values(sync.items).filter((item) => item.detailId)) {
    let publication;
    try { publication = await api(`/api/product-details/${source.detailId}/wordpress`); } catch (error) {
      if (error.statusCode === 404) continue;
      throw error;
    }
    if (!publication?.style_no) continue;
    items[source.offerId] = {
      offerId: source.offerId,
      detailId: String(source.detailId),
      styleNo: publication.style_no,
      categoryIds: publication.payload?.category_ids ?? [],
      primaryCategoryId: Number(publication.payload?.primary_category_id) || 0,
      tagIds: publication.payload?.tag_ids ?? [],
      material: publication.payload?.meta?.material || 'Polyester',
      jobId: null,
      stage: Array.isArray(publication.payload?.images) && publication.payload.images.length === 1
        ? 'completed' : 'pending',
      error: null,
    };
  }
  progress = { schemaVersion: 1, status: 'running', startedAt: now(), updatedAt: now(),
    completedAt: null, counts: {}, items };
  await save();
}

async function queuePending() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'pending')) {
    try {
      const job = await api(`/api/product-details/${item.detailId}/wordpress/publish`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'publish', styleNo: item.styleNo,
          categoryMode: 'manual', categoryIds: item.categoryIds,
          primaryCategoryId: item.primaryCategoryId,
          tagMode: 'manual', tagIds: item.tagIds,
          material: item.material, imageMode: 'main_only',
        }),
      });
      item.jobId = job.id;
      item.stage = 'queued';
    } catch (error) {
      item.stage = 'failed';
      item.error = error.message;
    }
  }
  await save();
}

async function advance() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'queued')) {
    try {
      const job = await api(`/api/wordpress-jobs/${item.jobId}`);
      if (['queued', 'running'].includes(job.status)) continue;
      if (job.status !== 'completed') throw new Error(job.error || `Sanitize job ended with ${job.status}.`);
      const publication = await api(`/api/product-details/${item.detailId}/wordpress`);
      if (!Array.isArray(publication?.payload?.images) || publication.payload.images.length !== 1) {
        throw new Error('WordPress product did not converge to one trusted main image.');
      }
      item.stage = 'completed';
    } catch (error) {
      if (error.statusCode === 404) {
        item.jobId = null;
        item.stage = 'pending';
      } else if (!transient(error)) {
        item.stage = 'failed';
        item.error = error.message;
      }
    }
  }
}

async function main() {
  try {
    progress = JSON.parse(await fs.readFile(progressPath, 'utf8'));
    progress.status = 'running';
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await initialize();
  }
  await queuePending();
  let lastLog = 0;
  while (!stopping) {
    await advance();
    await queuePending();
    await save();
    if (progress.counts.corrected + progress.counts.failed === progress.counts.total) {
      progress.status = progress.counts.failed ? 'completed_with_errors' : 'completed';
      progress.completedAt = now();
      await save();
      console.log(JSON.stringify({ at: now(), message: 'WordPress Gallery sanitize finished.', counts: progress.counts }));
      return;
    }
    if (Date.now() - lastLog > 60000) {
      console.log(JSON.stringify({ at: now(), message: 'WordPress Gallery sanitize is running.', counts: progress.counts }));
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
