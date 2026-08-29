import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const TITLE_NOISE_RE = /\b(?:20\d{2}|new arrival|new style|hot sale|best seller|cross[- ]border|aliexpress|amazon|export|wholesale)\b/i;
const VARIANT_APPEARANCE_RE = /\b(?:black|white|red|blue|green|pink|yellow|purple|orange|brown|beige|navy|floral|flower|printed|print|patterned|pattern|striped|stripe|polka[ -]?dot|leopard|abstract|color(?:ed|ful)?)\b/i;

function endpointFrom(baseUrl) {
  const base = String(baseUrl || ENDPOINT).replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { return null; }
}

function contentText(content) {
  return Array.isArray(content) ? content.map((part) => part?.text || '').join('') : String(content || '');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildProductTranslationSource(detail) {
  const raw = detail.raw_data && typeof detail.raw_data === 'object' ? detail.raw_data : {};
  return {
    offerId: detail.offer_id ?? raw.offerId ?? null,
    title: detail.title ?? raw.title ?? '',
    description: detail.description ?? raw.description ?? '',
    sellerName: detail.seller_name ?? raw.seller?.name ?? '',
    attributes: (detail.attributes || []).map((item, index) => ({
      index, name: item.name ?? '', value: item.value ?? '',
    })),
    skuDimensions: (raw.skuDimensions || []).map((item, index) => ({
      index, name: item?.name ?? '', values: Array.isArray(item?.values) ? item.values : [],
    })),
    skuOptions: (raw.skuOptions || []).map((item, index) => ({
      index, text: item?.text ?? '', imageUrl: item?.image ?? null,
    })),
    skuRows: (detail.skus || []).map((item, index) => ({
      index, skuKey: item.sku_key ?? '', skuText: item.sku_text ?? '',
      options: item.option_data && typeof item.option_data === 'object' ? item.option_data : {},
    })),
    priceTextCandidates: Array.isArray(raw.price?.textCandidates) ? raw.price.textCandidates : [],
  };
}

export function translationSourceHash(source) {
  return crypto.createHash('sha256').update(stableJson(source)).digest('hex');
}

export function selectTranslationImages(detail, limit = 6) {
  const selected = (detail.images || []).filter((item) => ['main', 'gallery'].includes(item.image_type))
    .sort((a, b) => {
      if (a.image_type === 'main' && b.image_type !== 'main') return -1;
      if (b.image_type === 'main' && a.image_type !== 'main') return 1;
      return Number(a.sort_order || 0) - Number(b.sort_order || 0);
    });
  const seen = new Set();
  return selected.filter((item) => {
    const key = item.source_url || item.storage_path;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.min(Math.max(Number(limit) || 6, 1), 8));
}

function englishWordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

export function validateGeneratedCatalogCopy(translated) {
  const title = String(translated.title || '').trim();
  const description = String(translated.description || '').trim();
  const titleWords = englishWordCount(title);
  const descriptionWords = englishWordCount(description);
  if (/[\u3400-\u9fff]/.test(title) || titleWords < 3 || titleWords > 12 || title.length > 100) {
    throw new Error('Generated English title is not a concise 3 to 12 word product name.');
  }
  if (TITLE_NOISE_RE.test(title) || VARIANT_APPEARANCE_RE.test(title)) {
    throw new Error('Generated English title contains year, marketplace, sales, color, or print keywords.');
  }
  if (/[\u3400-\u9fff]/.test(description) || descriptionWords < 35 || descriptionWords > 120) {
    throw new Error('Generated English description must be a 35 to 120 word English paragraph.');
  }
  if (VARIANT_APPEARANCE_RE.test(description)) {
    throw new Error('Generated English description contains color or print-specific language.');
  }
}

function hasMatchingIndices(sourceItems, translatedItems) {
  if (!Array.isArray(translatedItems) || translatedItems.length !== sourceItems.length) return false;
  return translatedItems.every((item, index) => Number(item?.index) === index);
}

export function validateProductTranslation(source, translated) {
  if (!translated || typeof translated !== 'object') throw new Error('Translation response is not a JSON object.');
  if (typeof translated.title !== 'string' || typeof translated.description !== 'string'
      || typeof translated.sellerName !== 'string') {
    throw new Error('Translation response is missing required text fields.');
  }
  for (const key of ['attributes', 'skuDimensions', 'skuOptions', 'skuRows']) {
    if (!hasMatchingIndices(source[key], translated[key])) {
      throw new Error(`Translation response does not preserve ${key} indices.`);
    }
  }
  if (!Array.isArray(translated.priceTextCandidates)
      || translated.priceTextCandidates.length !== source.priceTextCandidates.length) {
    throw new Error('Translation response does not preserve price text candidates.');
  }
  for (const [index, dimension] of source.skuDimensions.entries()) {
    if (!Array.isArray(translated.skuDimensions[index]?.values)
        || translated.skuDimensions[index].values.length !== dimension.values.length) {
      throw new Error(`Translation response does not preserve SKU dimension ${index} values.`);
    }
  }
  for (const [index, item] of translated.attributes.entries()) {
    if (typeof item.name !== 'string' || typeof item.value !== 'string') {
      throw new Error(`Translation response has invalid attribute ${index}.`);
    }
  }
  for (const [index, item] of translated.skuOptions.entries()) {
    if (typeof item.text !== 'string' || item.imageUrl !== source.skuOptions[index].imageUrl) {
      throw new Error(`Translation response changed SKU option identity ${index}.`);
    }
  }
  for (const [index, item] of translated.skuRows.entries()) {
    if (item.skuKey !== source.skuRows[index].skuKey || typeof item.skuText !== 'string'
        || !item.options || typeof item.options !== 'object' || Array.isArray(item.options)) {
      throw new Error(`Translation response changed SKU row identity ${index}.`);
    }
  }
  if (translated.priceTextCandidates.some((value) => typeof value !== 'string')) {
    throw new Error('Translation response contains a non-text price candidate.');
  }
  validateGeneratedCatalogCopy(translated);
  return translated;
}

async function loadTranslationImages(detail, config) {
  const storageRoot = path.resolve(config.storagePath || '/app/storage');
  const selected = selectTranslationImages(detail, config.maxTranslationImages || 6);
  const loaded = [];
  for (const [index, item] of selected.entries()) {
    let url = null;
    let transport = null;
    if (item.storage_path) {
      const imagePath = path.resolve(item.storage_path);
      if (imagePath.startsWith(`${storageRoot}${path.sep}`)) {
        try {
          const bytes = await fs.readFile(imagePath);
          if (bytes.length <= 15 * 1024 * 1024) {
            const ext = path.extname(imagePath).toLowerCase();
            const mime = item.mime_type || ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
              '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || 'image/jpeg';
            url = `data:${mime};base64,${bytes.toString('base64')}`;
            transport = 'persistent_storage';
          }
        } catch { /* fall back to the retained source URL */ }
      }
    }
    if (!url && /^https:\/\//i.test(item.source_url || '')) {
      url = item.source_url;
      transport = 'source_url';
    }
    if (!url) continue;
    loaded.push({ index, imageId: item.id ?? null, imageType: item.image_type,
      sortOrder: item.sort_order ?? 0, sourceUrl: item.source_url || null,
      storagePath: item.storage_path || null, transport, url });
  }
  if (!loaded.length) throw new Error('No saved main or Gallery image is available for visual product naming.');
  return loaded;
}

export async function translateProductDetail({ detail, targetLanguage = 'en', config }) {
  if (!config?.apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');
  if (targetLanguage !== 'en') throw new Error('Only English translation is currently supported.');
  const source = buildProductTranslationSource(detail);
  const model = config.complexModel || 'qwen3.8-max';
  const images = await loadTranslationImages(detail, config);
  const translationShape = {
    sellerName: '',
    attributes: source.attributes.map((item) => ({ index: item.index, name: '', value: '' })),
    skuDimensions: source.skuDimensions.map((item) => ({ index: item.index, name: '', values: item.values.map(() => '') })),
    skuOptions: source.skuOptions.map((item) => ({ index: item.index, text: '', imageUrl: item.imageUrl })),
    skuRows: source.skuRows.map((item) => ({ index: item.index, skuKey: item.skuKey, skuText: '', options: {} })),
    priceTextCandidates: source.priceTextCandidates.map(() => ''),
  };
  const imageContent = images.flatMap((image) => ([
    { type: 'text', text: `商品Gallery图片 ${image.index}` },
    { type: 'image_url', image_url: { url: image.url } },
  ]));

  async function callModel(content, maxTokens, label) {
    const response = await fetch(endpointFrom(config.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(360000),
    });
    if (!response.ok) throw new Error(`DashScope ${label} failed (${response.status}).`);
    const payload = await response.json();
    const raw = contentText(payload.choices?.[0]?.message?.content);
    return { payload, raw };
  }

  const visualPrompt = `你是专业的泳装和服装B2B商品内容编辑。综合全部Gallery图片识别同一个产品，只返回严格JSON：{"title":"","description":""}。
title必须根据图片重新命名，不能直译1688中文标题。使用3至12个英文单词的稳定产品名称；不得含年份、New Arrival、Hot Sale、Cross-Border、AliExpress、Amazon、Export、Wholesale、颜色、印花或图案。
description必须是35至120个英文单词的单段产品级描述。只写多张图片共同体现的稳定可见特点，例如品类、轮廓、领型、肩带、罩杯结构、开合、覆盖度、剪裁和套装组成。不得描述颜色、印花、图案、单个SKU、促销、年份、平台、SEO关键词、穿着效果、材质、功能或不可见信息。
中文标题仅可作为产品类别的弱提示，图片证据优先。不要输出Markdown或JSON之外的内容。
中文标题弱提示：${JSON.stringify(source.title)}`;
  async function requestVisualCopy(correction = '') {
    const text = correction ? `${visualPrompt}\n上一次输出未通过校验：${correction}。请重新输出。` : visualPrompt;
    return callModel([{ type: 'text', text }, ...imageContent], 1600, 'visual product copy generation');
  }
  let visualAttempt = await requestVisualCopy();
  let visualCopy = parseJson(visualAttempt.raw);
  try {
    validateGeneratedCatalogCopy(visualCopy || {});
  } catch (error) {
    visualAttempt = await requestVisualCopy(error.message);
    visualCopy = parseJson(visualAttempt.raw);
    validateGeneratedCatalogCopy(visualCopy || {});
  }

  const translationPrompt = `你是专业的泳装和服装B2B商品数据翻译器。把输入JSON中的属性、SKU和价格文字准确翻译为自然英文，只返回严格JSON。
要求：严格使用给定输出结构；所有数组数量、index、skuKey、imageUrl和原始顺序保持不变。保留款号、品牌名、数字、S/M/L/XL、罩杯、单位、货币和行业缩写；不得换算价格、库存、尺码或单位。SKU options对象的键和值都翻译，skuText翻译，skuKey原样保留。颜色、印花、部件、单件/套装、现货/预售按原意翻译。空字符串保持为空。不要输出Markdown或JSON之外的内容。
输出结构：${JSON.stringify(translationShape)}
输入JSON：${JSON.stringify({ sellerName: source.sellerName, attributes: source.attributes,
    skuDimensions: source.skuDimensions, skuOptions: source.skuOptions,
    skuRows: source.skuRows, priceTextCandidates: source.priceTextCandidates })}`;
  async function requestStructuredTranslation(correction = '') {
    const text = correction ? `${translationPrompt}\n上一次输出未通过校验：${correction}。请完整重新输出。` : translationPrompt;
    return callModel(text, 10000, 'structured product translation');
  }
  let translationAttempt = await requestStructuredTranslation();
  let structured = parseJson(translationAttempt.raw);
  let translated = { title: visualCopy.title, description: visualCopy.description, ...(structured || {}) };
  try {
    translated = validateProductTranslation(source, translated);
  } catch (error) {
    translationAttempt = await requestStructuredTranslation(error.message);
    structured = parseJson(translationAttempt.raw);
    translated = validateProductTranslation(source, {
      title: visualCopy.title, description: visualCopy.description, ...(structured || {}),
    });
  }
  const imageSources = images.map(({ url, ...image }) => image);
  return {
    schemaVersion: 2, sourceLanguage: 'zh-CN', targetLanguage, model,
    namingStrategy: 'visual_rewrite', imageSources,
    sourceHash: translationSourceHash({ source, imageSources }), source, translated,
    usage: { visual: visualAttempt.payload.usage ?? null,
      translation: translationAttempt.payload.usage ?? null },
  };
}
