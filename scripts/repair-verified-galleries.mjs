import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.COLLECTOR_BASE_URL || 'https://collector.yiswim.cloud').replace(/\/$/, '');
const apiKey = process.env.COLLECTOR_API_KEY;
const syncProgressPath = process.env.SYNC_PROGRESS_PATH;
const progressPath = process.env.VERIFIED_GALLERY_REPAIR_PROGRESS_PATH;
const maxInFlight = Math.min(Math.max(Number(process.env.GALLERY_REPAIR_CONCURRENCY) || 5, 1), 10);
const maxAttempts = Math.min(Math.max(Number(process.env.GALLERY_REPAIR_MAX_ATTEMPTS) || 3, 1), 5);
const pollMs = Math.max(Number(process.env.GALLERY_REPAIR_POLL_MS) || 5000, 3000);

if (!apiKey || !syncProgressPath || !progressPath) {
  throw new Error('COLLECTOR_API_KEY, SYNC_PROGRESS_PATH and VERIFIED_GALLERY_REPAIR_PROGRESS_PATH are required.');
}

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let progress;
let stopping = false;

function transient(error) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.statusCode))
    || /fetch failed|network|timeout|timed out|econnreset|socket hang up/i.test(String(error?.message || error));
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
    if (attempt < 4 && transient(error)) {
      await sleep(attempt * 1500);
      return api(endpoint, options, attempt + 1);
    }
    throw error;
  }
}

function productImageCount(detail) {
  return (detail?.images ?? []).filter((image) => ['main', 'gallery'].includes(image.image_type)).length;
}

function isVerified(detail) {
  const gallery = detail?.raw_data?.gallery;
  const downloaded = productImageCount(detail);
  return gallery?.source === 'exact_dom_gallery'
    && gallery?.complete === true
    && gallery?.stable === true
    && Number(gallery?.unresolvedSlotCount) === 0
    && Number(gallery?.imageCount) > 0
    && downloaded === Number(gallery.imageCount);
}

async function save() {
  const items = Object.values(progress.items);
  progress.updatedAt = now();
  progress.counts = {
    total: items.length,
    sourceOnlyMainBefore: items.filter((item) => item.sourceImageCountBefore <= 1).length,
    wordpressOnlyMainBefore: items.filter((item) => item.wasPublished && item.wordpressImageCountBefore <= 1).length,
    recapturePending: items.filter((item) => item.stage === 'recapture_pending').length,
    recapturing: items.filter((item) => item.stage === 'recapturing').length,
    verified: items.filter((item) => item.verified).length,
    republishing: items.filter((item) => item.stage === 'republishing').length,
    repairedPublished: items.filter((item) => item.stage === 'repaired_published').length,
    repairedUnpublished: items.filter((item) => item.stage === 'repaired_unpublished').length,
    failed: items.filter((item) => item.stage === 'failed').length,
  };
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  const temporary = `${progressPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(progress, null, 2), 'utf8');
  await fs.rename(temporary, progressPath);
}

async function mapLimit(values, limit, task) {
  const pending = new Set();
  const output = [];
  for (const value of values) {
    const promise = Promise.resolve().then(() => task(value)).finally(() => pending.delete(promise));
    pending.add(promise);
    output.push(promise);
    if (pending.size >= limit) await Promise.race(pending);
  }
  return Promise.all(output);
}

async function initialize() {
  const sync = JSON.parse(await fs.readFile(syncProgressPath, 'utf8'));
  const sources = Object.values(sync.items).filter((item) => item.detailId);
  const pairs = await mapLimit(sources, 5, async (source) => {
    const detail = await api(`/api/product-details/${source.detailId}`);
    let publication = null;
    try { publication = await api(`/api/product-details/${source.detailId}/wordpress`); } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    return { source, detail, publication };
  });
  const items = {};
  for (const { source, detail, publication } of pairs) {
    const wasPublished = Boolean(publication?.wp_post_id && publication?.style_no);
    items[source.offerId] = {
      detailId: String(source.detailId),
      sourceImageCountBefore: productImageCount(detail),
      wordpressImageCountBefore: Array.isArray(publication?.payload?.images)
        ? publication.payload.images.length : 0,
      wasPublished,
      publication: wasPublished ? {
        status: publication.wp_status || publication.payload?.status || 'publish',
        styleNo: publication.style_no,
        categoryIds: publication.payload?.category_ids ?? [],
        primaryCategoryId: Number(publication.payload?.primary_category_id)
          || Number(publication.payload?.category_ids?.[0]) || 0,
        tagIds: publication.payload?.tag_ids ?? [],
        tags: publication.payload?.tags ?? [],
        material: publication.payload?.meta?.material || 'Polyester',
      } : null,
      attempt: 0,
      recaptureJobId: null,
      wordpressJobId: null,
      sourceImageCountAfter: null,
      wordpressImageCountAfter: null,
      verified: false,
      stage: 'recapture_pending',
      error: null,
    };
  }
  progress = { schemaVersion: 2, status: 'running', startedAt: now(), updatedAt: now(),
    completedAt: null, counts: {}, items };
  await save();
}

async function queueRecaptures() {
  const active = Object.values(progress.items).filter((item) => item.stage === 'recapturing').length;
  const capacity = Math.max(0, maxInFlight - active);
  const pending = Object.values(progress.items)
    .filter((item) => item.stage === 'recapture_pending').slice(0, capacity);
  for (const item of pending) {
    try {
      const job = await api('/api/product-details', {
        method: 'POST', body: JSON.stringify({ offerId: progressItemKey(item) }),
      });
      item.attempt += 1;
      item.recaptureJobId = job.id;
      item.stage = 'recapturing';
      item.error = null;
    } catch (error) {
      item.error = error.message;
      if (item.attempt >= maxAttempts || !transient(error)) item.stage = 'failed';
    }
  }
}

function progressItemKey(item) {
  return Object.entries(progress.items).find(([, candidate]) => candidate === item)?.[0];
}

async function advanceRecaptures() {
  const active = Object.values(progress.items).filter((item) => item.stage === 'recapturing');
  await Promise.all(active.map(async (item) => {
    try {
      const job = await api(`/api/jobs/${item.recaptureJobId}`);
      if (['queued', 'running'].includes(job.status)) return;
      if (job.status !== 'completed') throw new Error(job.error || `Recapture ended with ${job.status}.`);
      const detail = await api(`/api/product-details/${item.detailId}`);
      item.sourceImageCountAfter = productImageCount(detail);
      if (!isVerified(detail)) {
        const gallery = detail?.raw_data?.gallery ?? {};
        throw new Error(`Gallery verification incomplete (complete=${Boolean(gallery.complete)}, downloaded=${item.sourceImageCountAfter}, expected=${Number(gallery.imageCount) || 0}).`);
      }
      item.verified = true;
      item.stage = item.wasPublished ? 'republish_pending' : 'repaired_unpublished';
      item.error = null;
    } catch (error) {
      if (transient(error)) return;
      item.error = error.message;
      item.recaptureJobId = null;
      item.stage = item.attempt < maxAttempts ? 'recapture_pending' : 'failed';
    }
  }));
}

async function queueWordPressRepairs() {
  const active = Object.values(progress.items).filter((item) => item.stage === 'republishing').length;
  const capacity = Math.max(0, maxInFlight - active);
  const pending = Object.values(progress.items)
    .filter((item) => item.stage === 'republish_pending').slice(0, capacity);
  for (const item of pending) {
    try {
      const options = item.publication;
      const job = await api(`/api/product-details/${item.detailId}/wordpress/publish`, {
        method: 'POST',
        body: JSON.stringify({
          status: options.status,
          styleNo: options.styleNo,
          categoryMode: 'manual',
          categoryIds: options.categoryIds,
          primaryCategoryId: options.primaryCategoryId,
          tagMode: 'manual',
          tagIds: options.tagIds,
          tags: options.tags,
          material: options.material,
        }),
      });
      item.wordpressJobId = job.id;
      item.stage = 'republishing';
    } catch (error) {
      if (!transient(error)) {
        item.stage = 'failed';
        item.error = error.message;
      }
    }
  }
}

async function advanceWordPressRepairs() {
  const active = Object.values(progress.items).filter((item) => item.stage === 'republishing');
  await Promise.all(active.map(async (item) => {
    try {
      const job = await api(`/api/wordpress-jobs/${item.wordpressJobId}`);
      if (['queued', 'running'].includes(job.status)) return;
      if (job.status !== 'completed') throw new Error(job.error || `WordPress repair ended with ${job.status}.`);
      const [detail, publication] = await Promise.all([
        api(`/api/product-details/${item.detailId}`),
        api(`/api/product-details/${item.detailId}/wordpress`),
      ]);
      const expected = productImageCount(detail);
      const actual = Array.isArray(publication?.payload?.images) ? publication.payload.images.length : 0;
      item.wordpressImageCountAfter = actual;
      if (actual !== expected) throw new Error(`WordPress Gallery has ${actual} images; expected ${expected}.`);
      item.stage = 'repaired_published';
      item.error = null;
    } catch (error) {
      if (transient(error)) return;
      item.stage = 'failed';
      item.error = error.message;
    }
  }));
}

async function main() {
  try {
    progress = JSON.parse(await fs.readFile(progressPath, 'utf8'));
    progress.status = 'running';
    progress.completedAt = null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await initialize();
  }

  let lastLogAt = 0;
  while (!stopping) {
    await advanceRecaptures();
    await queueRecaptures();
    await advanceWordPressRepairs();
    await queueWordPressRepairs();
    await save();

    const terminal = progress.counts.repairedPublished
      + progress.counts.repairedUnpublished + progress.counts.failed;
    if (terminal === progress.counts.total) {
      progress.status = progress.counts.failed ? 'completed_with_errors' : 'completed';
      progress.completedAt = now();
      await save();
      console.log(JSON.stringify({ at: now(), message: 'Verified Gallery repair finished.', counts: progress.counts }));
      return;
    }
    if (Date.now() - lastLogAt >= 60000) {
      console.log(JSON.stringify({ at: now(), message: 'Verified Gallery repair is running.', counts: progress.counts }));
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
