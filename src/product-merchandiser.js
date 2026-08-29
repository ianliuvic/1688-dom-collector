import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function endpointFrom(baseUrl) {
  const base = clean(baseUrl || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
}

function parseJson(text) {
  const cleaned = clean(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { return null; }
}

function contentText(content) {
  return Array.isArray(content) ? content.map((part) => part?.text || '').join('') : String(content || '');
}

function uniqueNumbers(values) {
  return [...new Set((values || []).map(Number).filter(Number.isInteger))];
}

function uniqueText(values) {
  return [...new Set((values || []).map(clean).filter(Boolean))];
}

async function loadImages(detail, config, limit = 4) {
  const root = path.resolve(config.storagePath || '/app/storage');
  const source = (detail.images || [])
    .filter((image) => ['main', 'gallery'].includes(image.image_type))
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  const loaded = [];
  const seen = new Set();
  for (const image of source) {
    const identity = clean(image.source_url) || clean(image.storage_path);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    let url = '';
    const sourceUrl = /^https:\/\//i.test(clean(image.source_url)) ? clean(image.source_url) : '';
    if (config.modelImageTransport !== 'persistent_storage' && sourceUrl) url = sourceUrl;
    if (!url && image.storage_path) {
      const filename = path.resolve(image.storage_path);
      if (filename.startsWith(`${root}${path.sep}`)) {
        try {
          const bytes = await fs.readFile(filename);
          if (bytes.length <= 15 * 1024 * 1024) {
            url = `data:${clean(image.mime_type) || 'image/jpeg'};base64,${bytes.toString('base64')}`;
          }
        } catch { /* use source URL below */ }
      }
    }
    if (!url && sourceUrl) url = sourceUrl;
    if (url) loaded.push({ url, sourceUrl: clean(image.source_url), imageId: image.id ?? null });
    if (loaded.length >= limit) break;
  }
  return loaded;
}

export function validateMerchandisingProfile(profile, taxonomies) {
  if (!profile || typeof profile !== 'object') throw new Error('Merchandising response is not JSON.');
  const categoryIds = new Set((taxonomies.categories || []).map((item) => Number(item.id)));
  const selected = uniqueNumbers(profile.categoryIds).filter((id) => categoryIds.has(id));
  const primary = Number(profile.primaryCategoryId);
  if (!categoryIds.has(primary)) throw new Error('The model did not select a valid primary category.');
  if (!selected.includes(primary)) selected.unshift(primary);
  const tags = uniqueText(profile.tags).slice(0, 8);
  if (!tags.length) throw new Error('The model did not return any usable product tags.');
  return {
    schemaVersion: 1,
    primaryCategoryId: primary,
    categoryIds: selected,
    tags,
    material: clean(profile.material),
    confidence: Math.max(0, Math.min(1, Number(profile.confidence) || 0)),
    warnings: uniqueText(profile.warnings),
  };
}

export async function analyzeProductMerchandising({ detail, translation, taxonomies, config }) {
  if (!config?.apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');
  const categories = (taxonomies.categories || []).map(({ id, name, parent }) => ({ id, name, parent }));
  if (!categories.length) throw new Error('WordPress has no product categories available for matching.');
  const existingTags = (taxonomies.tags || []).map(({ id, name }) => ({ id, name }));
  const images = await loadImages(detail, config, 4);
  const model = config.complexModel || 'qwen3.8-max';
  const source = {
    englishTitle: translation.title,
    englishDescription: translation.description,
    sourceTitle: detail.title,
    attributes: translation.attributes || [],
    skuDimensions: translation.sku_dimensions || [],
    skuOptions: translation.sku_options || [],
  };
  const prompt = `You are the merchandising classifier for a swimwear catalog. Return strict JSON only:
{"primaryCategoryId":0,"categoryIds":[],"tags":[],"material":"","confidence":0.0,"warnings":[]}

Category rules:
- Select only IDs from AVAILABLE CATEGORIES. primaryCategoryId is the single most specific intrinsic product type.
- categoryIds may include the primary category, its relevant parent category, and other genuinely useful product-type categories.
- Never select merchandising badges such as Best Sellers or Factory Quality Choice from visual appearance.
- A product may belong to several categories, but do not add merely plausible categories.

Tag rules:
- Return 2-8 concise English style/filter tags supported by visible or explicit evidence.
- Prefer an exact EXISTING TAG name for the same concept. Create a normalized Title Case tag only when no equivalent exists.
- Do not use colors, years, marketplaces, sales claims, seller names, gender, or the product category as tags.
- Avoid near-duplicate synonyms so the catalog develops a controlled reusable vocabulary.

Material rules:
- Use explicit product attributes/detail text as the primary evidence and translate the composition naturally into English.
- Do not infer a fiber composition from appearance alone. Return an empty material when evidence is insufficient; the publisher applies its configured fallback.

AVAILABLE CATEGORIES: ${JSON.stringify(categories)}
EXISTING TAGS: ${JSON.stringify(existingTags)}
PRODUCT DATA: ${JSON.stringify(source)}`;
  const content = [{ type: 'text', text: prompt }];
  for (const [index, image] of images.entries()) {
    content.push({ type: 'text', text: `Gallery image ${index + 1}` });
    content.push({ type: 'image_url', image_url: { url: image.url } });
  }
  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 1800 }),
    signal: AbortSignal.timeout(360000),
  });
  if (!response.ok) throw new Error(`DashScope merchandising classification failed (${response.status}).`);
  const body = await response.json();
  const profile = validateMerchandisingProfile(
    parseJson(contentText(body.choices?.[0]?.message?.content)), taxonomies,
  );
  return { ...profile, model, imageSources: images.map(({ url, ...item }) => item), usage: body.usage ?? null };
}
