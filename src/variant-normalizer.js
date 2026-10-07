// Variant normalization (swatch + size) with a vision model.
//
// The model looks at the product's gallery images and the current SKU swatch
// images, then proposes for every EXISTING source option:
//   - a concise English swatch text, a short uppercase code (for SKU building)
//     and the image that best shows that variant (its own swatch, a gallery
//     image, or none);
//   - a standardized size label (translated, placeholders removed, canonical
//     order).
// The model never invents, deletes or reorders SKU rows: the server validates a
// strict one-to-one mapping back to the source option values, dedupes codes and
// marks anything unresolved for human review.

import { applyReasoning } from './model-request.js';

const FALLBACK_BASE_URL = 'https://api.deepseek.com';
// The provider accepts up to 600 images per request; use that ceiling directly
// instead of any artificial cap.
const MAX_IMAGES = 600;
const SIZE_RE = /(尺码|尺寸|码数|size)/i;
const COLOR_RE = /(颜色|color|colour)/i;
const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL'];

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function endpointFrom(baseUrl) {
  const base = String(baseUrl || FALLBACK_BASE_URL).replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
}

function publicImageUrl(storagePath, baseUrl) {
  if (!storagePath) return null;
  const normalized = String(storagePath).replace(/\\/g, '/');
  const parts = normalized.split('/');
  const file = parts.pop();
  const folder = parts.pop();
  if (!file || !folder) return null;
  return `${String(baseUrl || '').replace(/\/+$/, '')}/api/product-images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

function normalizeImageKey(value) {
  return String(value ?? '').trim().replace(/^http:/i, 'https:')
    .replace(/[?#].*$/, '').replace(/_\.webp$/i, '').replace(/_\d+x\d+[^/]*$/i, '');
}

/** Every image URL inside an HTML fragment (LinkFox description pages). */
function extractHtmlImageUrls(html) {
  const urls = [];
  for (const match of String(html ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    let url = match[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (/^https:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

/** Build the labelled image list and the source option lists for one detail. */
export function buildNormalizeInput(detail, { baseUrl } = {}) {
  const raw = detail?.raw_data ?? {};
  const options = Array.isArray(raw.skuOptions) ? raw.skuOptions : [];
  const colourOptions = options.filter((option) => COLOR_RE.test(String(option?.dimensionName ?? '')));
  if (!colourOptions.length) {
    for (const option of options) {
      if (!SIZE_RE.test(String(option?.dimensionName ?? ''))) colourOptions.push(option);
    }
  }
  const images = [];
  const seenUrls = new Set();
  const push = (image, role, label, explicitUrl = null) => {
    if (images.length >= MAX_IMAGES) return;
    const url = explicitUrl
      || (/^https:\/\//i.test(image?.source_url || '') ? cleanText(image.source_url)
        : publicImageUrl(image?.storage_path, baseUrl));
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    images.push({ id: image?.id != null ? String(image.id) : `url:${url}`, role, label, url, type: image?.image_type ?? role });
  };
  for (const image of (detail?.images ?? []).filter((item) => item.image_type === 'main' || item.image_type === 'gallery')
    .sort((left, right) => (left.image_type !== right.image_type
      ? (left.image_type === 'main' ? -1 : 1) : Number(left.sort_order) - Number(right.sort_order)))) {
    push(image, 'gallery', image.image_type === 'main' ? '主图' : '商品图');
  }
  // Detail images: stored copies first, then every image URL inside the
  // LinkFox description HTML (the links are already in the database).
  for (const image of (detail?.images ?? []).filter((item) => item.image_type === 'description')) {
    push(image, 'description', '详情图');
  }
  const descriptionHtml = raw?.linkfox?.raw?.description ?? '';
  for (const url of extractHtmlImageUrls(descriptionHtml)) {
    push(null, 'description', '详情图', url);
  }
  const skuImageByKey = new Map((detail?.images ?? []).filter((image) => image.image_type === 'sku')
    .map((image) => [normalizeImageKey(image.source_url), image]));
  const colours = colourOptions.map((option) => {
    const value = cleanText(option?.text);
    const source = cleanText(option?.image);
    const matched = source ? skuImageByKey.get(normalizeImageKey(source)) : null;
    return {
      value,
      ownImageId: matched ? String(matched.id) : null,
      ownImageUrl: source || null,
      // Fallback map entry so a variant's own swatch image can always be used,
      // even when the image was not pushed to the model.
      ownImage: matched ?? null,
    };
  }).filter((colour) => colour.value);
  for (const colour of colours) {
    const image = colour.ownImage;
    if (image) push(image, 'swatch', `变体色卡：${colour.value}`);
  }
  const sizeDimension = (Array.isArray(raw.skuDimensions) ? raw.skuDimensions : [])
    .find((dimension) => SIZE_RE.test(String(dimension?.name ?? '')));
  const sizes = [...new Set([
    ...(Array.isArray(sizeDimension?.values) ? sizeDimension.values : []).map(cleanText),
    ...options.filter((option) => SIZE_RE.test(String(option?.dimensionName ?? ''))).map((option) => cleanText(option?.text)),
  ].filter(Boolean))];
  const numbered = images.map((image, index) => ({ ...image, number: index + 1 }));
  return { title: cleanText(detail?.title), colours, sizes, images: numbered };
}

function sanitizeCode(value) {
  const code = String(value ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
  return code || null;
}

function naturalSizeRank(label) {
  const upper = label.toUpperCase();
  const index = SIZE_ORDER.indexOf(upper);
  if (index >= 0) return [0, index];
  const numeric = Number(label.match(/\d+(?:\.\d+)?/)?.[0]);
  if (Number.isFinite(numeric) && /^\d/.test(label)) return [1, numeric];
  if (/(均码|one\s*size|free)/i.test(label)) return [2, 0];
  return [3, 0];
}

/** Validate the model proposal and merge it with the source options. */
export function normalizeVariantResult(parsed, input) {
  const imageById = new Map(input.images.map((image) => [String(image.id), image]));
  const imageByNumber = new Map(input.images.map((image) => [image.number, image]));
  const ownImageById = new Map(input.colours.filter((colour) => colour.ownImage)
    .map((colour) => [colour.ownImageId, colour.ownImage]));
  const bySource = new Map((Array.isArray(parsed?.colours) ? parsed.colours : [])
    .map((colour) => [cleanText(colour?.source), colour]));
  const usedCodes = new Set();
  const colours = [];
  for (const colour of input.colours) {
    const proposal = bySource.get(colour.value) ?? {};
    let code = sanitizeCode(proposal.code);
    if (code) {
      let candidate = code;
      let suffix = 2;
      while (usedCodes.has(candidate)) { candidate = `${code}-${suffix}`; suffix += 1; }
      code = candidate;
      usedCodes.add(candidate);
    }
    const evidenceNumber = Number(proposal.imageNumber);
    const evidence = imageByNumber.get(evidenceNumber) ?? null;
    // The variant's own swatch image is the default whenever the model could
    // not point at a gallery image (or was never shown the swatch).
    const ownImage = colour.ownImageId
      ? (imageById.get(String(colour.ownImageId)) ?? ownImageById.get(String(colour.ownImageId)) ?? null)
      : null;
    const chosen = evidence ?? ownImage ?? null;
    colours.push({
      source: colour.value,
      text: cleanText(proposal.text).slice(0, 60) || null,
      code,
      imageId: chosen ? String(chosen.id) : null,
      imageRole: chosen ? (evidence ? evidence.role : 'swatch') : null,
      confidence: Number.isFinite(Number(proposal.confidence)) ? Number(proposal.confidence) : null,
      placeholder: proposal.placeholder === true,
      needsReview: !cleanText(proposal.text) || !chosen,
    });
  }
  const sizeBySource = new Map((Array.isArray(parsed?.sizes) ? parsed.sizes : [])
    .map((size) => [cleanText(size?.source), size]));
  const sizes = input.sizes.map((value) => {
    const proposal = sizeBySource.get(value) ?? {};
    return {
      source: value,
      text: cleanText(proposal.text).slice(0, 40) || null,
      placeholder: proposal.placeholder === true,
      needsReview: !cleanText(proposal.text),
    };
  });
  sizes.sort((left, right) => {
    const [kindA, rankA] = naturalSizeRank(cleanText(left.text) || left.source);
    const [kindB, rankB] = naturalSizeRank(cleanText(right.text) || right.source);
    return kindA - kindB || rankA - rankB;
  });
  return {
    version: 1,
    colours,
    sizes,
    notes: cleanText(parsed?.notes).slice(0, 500),
    updatedAt: new Date().toISOString(),
  };
}

export async function normalizeVariants({ detail, config = {}, baseUrl }) {
  const input = buildNormalizeInput(detail, { baseUrl });
  const colourLines = input.colours.map((colour) => `- ${colour.value}`).join('\n') || '（无颜色选项）';
  const sizeLines = input.sizes.map((size) => `- ${size}`).join('\n') || '（无尺码选项）';
  const imageLines = input.images.map((image) => `${image.number}. ${image.label}`).join('\n');
  const prompt = `你是电商商品变体规范化助手，只输出严格JSON。
下面是一个 1688 商品的标题、图片（按编号顺序提供）、以及当前的颜色选项文本和尺码选项文本。
请完成两件事：
一、颜色/花色变体规范化。看图片判断这个商品实际有几款颜色/印花，并把它和下面的颜色选项一一对应：
- 为每个颜色选项输出：简洁准确的英文名称（≤4 个单词，如 Black and White、Leopard、Sky Blue）、一个用于构建 SKU 的短缩写（大写字母/数字/连字符，≤8 字符，如 BW、LEOP、SKYBLU）、最能代表该变体的图片编号。
- 图片编号优先选"变体色卡"图；没有色卡图时，从商品图里选出能看清该颜色的那张；都看不出来时 imageNumber 用 null，confidence 给低分。
- 如果某个颜色文本没有意义（如"现货放心拍""包邮""图片色"这类占位或卖家文案），仍要输出一行，但 placeholder 设为 true，同时根据图片给出正确的英文名称（如果确实能从图片看出颜色）。
- 绝不能编造不存在的颜色，也不能遗漏或多出任何选项，source 必须逐字使用给出的原文。
二、尺码规范化。为每个尺码选项输出标准英文标签（如 均码→One Size、加大码→XL），去掉占位/无意义项（placeholder=true），不要合并不同尺码。
输出格式：
{"colours":[{"source":"原文","text":"英文名","code":"缩写","imageNumber":3,"confidence":0.9,"placeholder":false}],"sizes":[{"source":"原文","text":"标准英文","placeholder":false}],"notes":"一句话备注"}

标题：${JSON.stringify(input.title)}
颜色选项：
${colourLines}
尺码选项：
${sizeLines}
图片清单：
${imageLines}`;

  const content = [
    { type: 'text', text: prompt },
    ...input.images.map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
  ];
  let lastRaw = '';
  let lastProblem = 'no usable result';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const messages = attempt === 1 ? [{ role: 'user', content }] : [{ role: 'user', content: [...content, {
      type: 'text',
      text: `上一次输出无法使用（${lastProblem}）。原文片段：${String(lastRaw).slice(0, 300)}
请重新输出严格 JSON，colours 必须覆盖每一个颜色选项且 source 逐字一致，sizes 必须覆盖每一个尺码选项。`,
    }] }];
    const response = await fetch(endpointFrom(config.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(applyReasoning({
        model: config.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 384000,
      }, config.reasoningEffort)),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      const detailText = await response.text().catch(() => '');
      throw new Error(`Variant normalization failed (${response.status}): ${String(detailText).slice(0, 200)}`);
    }
    const payload = await response.json();
    const text = contentText(payload.choices?.[0]?.message?.content);
    lastRaw = text;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed) {
      const match = String(text || '').match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }
    }
    if (!parsed || !Array.isArray(parsed.colours)) {
      lastProblem = 'JSON 无法解析或缺少 colours';
      continue;
    }
    const result = normalizeVariantResult(parsed, input);
    return { input, result };
  }
  throw new Error(`Variant normalization returned no usable result: ${String(lastRaw).slice(0, 300)}`);
}
