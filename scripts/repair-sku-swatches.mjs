import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.COLLECTOR_BASE_URL || 'https://collector.yiswim.cloud').replace(/\/$/, '');
const apiKey = process.env.COLLECTOR_API_KEY;
const sourceProgressPath = process.env.GALLERY_REPAIR_SOURCE_PATH;
const progressPath = process.env.SKU_SWATCH_REPAIR_PROGRESS_PATH;
const styles = ['SWOP136', 'SWBK169', 'SWBK172', 'SWBK166', 'SWBK160'];
const pollMs = 5000;

if (!apiKey || !sourceProgressPath || !progressPath) {
  throw new Error('COLLECTOR_API_KEY, GALLERY_REPAIR_SOURCE_PATH and SKU_SWATCH_REPAIR_PROGRESS_PATH are required.');
}

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let progress;

function transient(error) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.statusCode))
    || /fetch failed|network|timeout|timed out|econnreset/i.test(String(error?.message || error));
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

function colorOptions(detail) {
  return (detail?.raw_data?.skuOptions ?? []).filter((option) =>
    /^(?:颜色|color)$/i.test(String(option?.dimensionName || '').trim()));
}

async function save() {
  const items = Object.values(progress.items);
  progress.updatedAt = now();
  progress.counts = {
    total: items.length,
    recaptured: items.filter((item) => item.recaptured).length,
    translated: items.filter((item) => item.translated).length,
    repaired: items.filter((item) => item.stage === 'completed').length,
    failed: items.filter((item) => item.stage === 'failed').length,
  };
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  const temporary = `${progressPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(progress, null, 2), 'utf8');
  await fs.rename(temporary, progressPath);
}

async function initialize() {
  const source = JSON.parse(await fs.readFile(sourceProgressPath, 'utf8'));
  const entries = Object.values(source.items);
  const items = {};
  for (const style of styles) {
    const found = entries.find((item) => item.publication?.styleNo === style);
    if (!found) throw new Error(`Could not resolve ${style} from the verified Gallery repair.`);
    const publication = await api(`/api/product-details/${found.detailId}/wordpress`);
    items[style] = {
      style,
      detailId: String(found.detailId),
      publication: {
        status: publication.wp_status || publication.payload?.status || 'publish',
        styleNo: publication.style_no,
        categoryIds: publication.payload?.category_ids ?? [],
        primaryCategoryId: Number(publication.payload?.meta?.primary_category_id)
          || Number(publication.payload?.category_ids?.[0]) || 0,
        tagIds: publication.payload?.tag_ids ?? [],
        tags: publication.payload?.tags ?? [],
        material: publication.payload?.meta?.material || 'Polyester',
      },
      recaptureJobId: null,
      translationJobId: null,
      wordpressJobId: null,
      expectedColors: null,
      recaptured: false,
      translated: false,
      stage: 'recapture_pending',
      error: null,
    };
  }
  progress = { schemaVersion: 1, status: 'running', startedAt: now(), updatedAt: now(),
    completedAt: null, counts: {}, items };
  await save();
}

async function queueRecaptures() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'recapture_pending')) {
    try {
      const job = await api('/api/product-details', {
        method: 'POST', body: JSON.stringify({ offerId: (await api(`/api/product-details/${item.detailId}`)).offer_id }),
      });
      item.recaptureJobId = job.id;
      item.stage = 'recapturing';
    } catch (error) {
      item.stage = 'failed';
      item.error = error.message;
    }
  }
}

async function advanceRecaptures() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'recapturing')) {
    try {
      const job = await api(`/api/jobs/${item.recaptureJobId}`);
      if (['queued', 'running'].includes(job.status)) continue;
      if (job.status !== 'completed') throw new Error(job.error || `Recapture ended with ${job.status}.`);
      const detail = await api(`/api/product-details/${item.detailId}`);
      const colors = colorOptions(detail);
      const skuImages = (detail.images ?? []).filter((image) => image.image_type === 'sku');
      const labels = colors.map((option) => option.text);
      if (!colors.length || new Set(labels).size !== colors.length) {
        throw new Error('Exact color options are empty or duplicated after recapture.');
      }
      const mapped = new Set(colors.map((option) => option.image).filter(Boolean));
      if (mapped.size !== colors.length || skuImages.length < colors.length) {
        throw new Error(`SKU image mapping is incomplete (${mapped.size}/${colors.length}).`);
      }
      item.expectedColors = colors.length;
      item.recaptured = true;
      item.stage = 'translation_pending';
    } catch (error) {
      if (transient(error)) continue;
      item.stage = 'failed';
      item.error = error.message;
    }
  }
}

async function queueTranslations() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'translation_pending')) {
    try {
      const job = await api(`/api/product-details/${item.detailId}/translations`, {
        method: 'POST', body: JSON.stringify({ targetLanguage: 'en', preserveCatalogCopy: true }),
      });
      item.translationJobId = job.id;
      item.stage = 'translating';
    } catch (error) {
      item.stage = 'failed';
      item.error = error.message;
    }
  }
}

async function advanceTranslations() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'translating')) {
    try {
      const job = await api(`/api/translation-jobs/${item.translationJobId}`);
      if (['queued', 'running'].includes(job.status)) continue;
      if (job.status !== 'completed') throw new Error(job.error || `Translation ended with ${job.status}.`);
      if ((job.result?.sku_options ?? []).length !== item.expectedColors) {
        throw new Error('Translated SKU option count does not match the exact source colors.');
      }
      item.translated = true;
      item.stage = 'publish_pending';
    } catch (error) {
      if (transient(error)) continue;
      item.stage = 'failed';
      item.error = error.message;
    }
  }
}

async function queuePublishes() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'publish_pending')) {
    try {
      const p = item.publication;
      const job = await api(`/api/product-details/${item.detailId}/wordpress/publish`, {
        method: 'POST', body: JSON.stringify({ status: p.status, styleNo: p.styleNo,
          categoryMode: 'manual', categoryIds: p.categoryIds, primaryCategoryId: p.primaryCategoryId,
          tagMode: 'manual', tagIds: p.tagIds, tags: p.tags, material: p.material }),
      });
      item.wordpressJobId = job.id;
      item.stage = 'publishing';
    } catch (error) {
      item.stage = 'failed';
      item.error = error.message;
    }
  }
}

async function advancePublishes() {
  for (const item of Object.values(progress.items).filter((entry) => entry.stage === 'publishing')) {
    try {
      const job = await api(`/api/wordpress-jobs/${item.wordpressJobId}`);
      if (['queued', 'running'].includes(job.status)) continue;
      if (job.status !== 'completed') throw new Error(job.error || `Publish ended with ${job.status}.`);
      const publication = await api(`/api/product-details/${item.detailId}/wordpress`);
      const colors = publication.payload?.colors?.colors ?? [];
      const imageIds = colors.map((color) => Number(color.image_id) || 0).filter(Boolean);
      if (colors.length !== item.expectedColors || new Set(imageIds).size !== item.expectedColors) {
        throw new Error(`Published swatches are not one-to-one (${colors.length} colors, ${new Set(imageIds).size} images).`);
      }
      item.stage = 'completed';
      item.error = null;
    } catch (error) {
      if (transient(error)) continue;
      item.stage = 'failed';
      item.error = error.message;
    }
  }
}

async function main() {
  try {
    progress = JSON.parse(await fs.readFile(progressPath, 'utf8'));
    progress.status = 'running';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await initialize();
  }
  let lastLog = 0;
  while (true) {
    await advanceRecaptures();
    await queueRecaptures();
    await advanceTranslations();
    await queueTranslations();
    await advancePublishes();
    await queuePublishes();
    await save();
    if (progress.counts.repaired + progress.counts.failed === progress.counts.total) {
      progress.status = progress.counts.failed ? 'completed_with_errors' : 'completed';
      progress.completedAt = now();
      await save();
      console.log(JSON.stringify({ at: now(), message: 'SKU swatch repair finished.', counts: progress.counts }));
      return;
    }
    if (Date.now() - lastLog >= 60000) {
      console.log(JSON.stringify({ at: now(), message: 'SKU swatch repair is running.', counts: progress.counts }));
      lastLog = Date.now();
    }
    await sleep(pollMs);
  }
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
