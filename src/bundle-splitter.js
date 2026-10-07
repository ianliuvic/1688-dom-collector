// LLM bundle-split analysis.
//
// Given a captured bundle product, the model reads the variant option texts
// AND the product images, then groups the options into the independent products
// that are actually sold in that listing. Seller chatter ("现货 放心拍") is
// ignored, same-garment colour variants merge into one product, and every
// gallery image is assigned to the product(s) it shows. Sizes and prices are
// derived from the stored SKU matrix, never from the model.

import { applyReasoning } from './model-request.js';

const SIZE_RE = /(尺码|尺寸|码数|size)/i;
const COLOR_RE = /(颜色|color|colour)/i;
const MAX_IMAGES = 600;
const MAX_PRODUCTS = 6;
const FALLBACK_BASE_URL = 'https://api.deepseek.com';

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

export function publicImageUrl(storagePath, baseUrl) {
  if (!storagePath) return null;
  const normalized = String(storagePath).replace(/\\/g, '/');
  const parts = normalized.split('/');
  const file = parts.pop();
  const folder = parts.pop();
  if (!file || !folder) return null;
  return `${String(baseUrl || '').replace(/\/+$/, '')}/api/product-images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

function extractHtmlImageUrls(html) {
  const urls = [];
  for (const match of String(html ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    let url = match[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    if (/^https:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

/** Colour/option texts and the ordered main+gallery+detail images for one detail. */
export function buildSplitInput(detail, { baseUrl } = {}) {
  const raw = detail?.raw_data ?? {};
  const options = Array.isArray(raw.skuOptions) ? raw.skuOptions : [];
  const optionsOf = (predicate) => {
    const values = [];
    for (const option of options) {
      if (!predicate(String(option?.dimensionName ?? ''))) continue;
      const text = cleanText(option?.text);
      if (text && !values.includes(text)) values.push(text);
    }
    return values;
  };
  let colourOptions = optionsOf((name) => COLOR_RE.test(name));
  if (!colourOptions.length) colourOptions = optionsOf((name) => !SIZE_RE.test(name));
  const images = [];
  const seen = new Set();
  const push = (image, role, label, explicitUrl = null) => {
    if (images.length >= MAX_IMAGES) return;
    // Prefer the original CDN URL (the same source the translator uses, which
    // the vision provider reliably accepts), fall back to our hosted copy.
    const sourceUrl = image && /^https:\/\//i.test(image.source_url || '') ? cleanText(image.source_url) : null;
    const url = explicitUrl || sourceUrl || publicImageUrl(image?.storage_path, baseUrl) || null;
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push({
      id: image?.id != null ? String(image.id) : null,
      url,
      type: image?.image_type ?? role,
      role,
      label,
      sortOrder: Number(image?.sort_order) || 0,
      index: images.length + 1,
    });
  };
  for (const image of (detail?.images ?? [])
    .filter((item) => item.image_type === 'main' || item.image_type === 'gallery')
    .sort((left, right) => {
      if (left.image_type !== right.image_type) return left.image_type === 'main' ? -1 : 1;
      return Number(left.sort_order) - Number(right.sort_order);
    })) {
    push(image, 'gallery', image.image_type === 'main' ? '主图' : '商品图');
  }
  for (const image of (detail?.images ?? []).filter((item) => item.image_type === 'description')) {
    push(image, 'description', '详情图');
  }
  // Detail-image links that live in the LinkFox description HTML (no local copy).
  for (const url of extractHtmlImageUrls(raw?.linkfox?.raw?.description)) {
    push(null, 'description', '详情图', url);
  }
  const skuImageByKey = new Map();
  for (const image of (detail?.images ?? []).filter((item) => item.image_type === 'sku')) {
    const key = String(image.source_url ?? '').trim().replace(/^http:/i, 'https:').replace(/[?#].*$/, '')
      .replace(/_\.webp$/i, '').replace(/_\d+x\d+[^/]*$/i, '');
    skuImageByKey.set(key, image);
  }
  for (const option of options) {
    if (!COLOR_RE.test(String(option?.dimensionName ?? ''))) continue;
    const source = cleanText(option?.image);
    if (!source) continue;
    const key = source.replace(/^http:/i, 'https:').replace(/[?#].*$/, '')
      .replace(/_\.webp$/i, '').replace(/_\d+x\d+[^/]*$/i, '');
    const matched = skuImageByKey.get(key);
    push(matched ?? null, 'swatch', `变体色卡：${cleanText(option?.text)}`, matched ? null : source);
  }
  return { title: cleanText(detail?.title), colourOptions, images };
}

/** Sizes and max price for one group of option texts, from the stored matrix. */
export function sizesAndPriceForOptions(raw, groupOptions) {
  const wanted = new Set(groupOptions.map(cleanText).filter(Boolean));
  const rows = Array.isArray(raw?.skuMatrix?.rows) ? raw.skuMatrix.rows : [];
  const sizes = [];
  let priceMax = null;
  for (const row of rows) {
    const values = Object.values(row?.options ?? {}).map(cleanText);
    if (!values.some((value) => wanted.has(value))) continue;
    for (const [name, value] of Object.entries(row?.options ?? {})) {
      if (!SIZE_RE.test(String(name))) continue;
      const text = cleanText(value);
      if (text && !sizes.includes(text)) sizes.push(text);
    }
    const price = Number(row?.price);
    if (Number.isFinite(price) && price > 0) priceMax = priceMax === null ? price : Math.max(priceMax, price);
  }
  return { sizes, priceMax };
}

function splitImageRefs(numbers, input) {
  const ids = [];
  const urls = [];
  for (const value of Array.isArray(numbers) ? numbers : []) {
    const position = Number(value);
    if (!Number.isInteger(position) || position < 1 || position > input.images.length) continue;
    const image = input.images[position - 1];
    if (image.id) ids.push(String(image.id));
    else if (image.url) urls.push(String(image.url));
  }
  return { imageIds: [...new Set(ids)], imageUrls: [...new Set(urls)] };
}

function normalisePlan(products, ignoredOptions, input, raw) {
  const seen = new Set();
  const result = [];
  for (const product of products.slice(0, MAX_PRODUCTS)) {
    const optionTexts = (Array.isArray(product?.options) ? product.options : [])
      .map(cleanText)
      .filter((text) => input.colourOptions.includes(text) && !seen.has(text));
    if (!optionTexts.length) continue;
    optionTexts.forEach((text) => seen.add(text));
    const { imageIds, imageUrls } = splitImageRefs(product?.images, input);
    const { sizes, priceMax } = sizesAndPriceForOptions(raw, optionTexts);
    result.push({
      id: `p${result.length + 1}`,
      name: cleanText(product?.name).slice(0, 80) || optionTexts[0],
      options: optionTexts,
      imageIds,
      imageUrls,
      sizes,
      priceMax,
      reason: cleanText(product?.reason).slice(0, 200),
    });
  }
  const ignored = (Array.isArray(ignoredOptions) ? ignoredOptions : [])
    .map(cleanText)
    .filter((text) => text && input.colourOptions.includes(text) && !seen.has(text));
  return { products: result, ignoredOptions: [...new Set(ignored)] };
}

export async function analyzeBundleSplit({ detail, config = {}, baseUrl }) {
  const raw = detail?.raw_data ?? {};
  const input = buildSplitInput(detail, { baseUrl });
  if (input.colourOptions.length <= 1) {
    const single = {
      version: 2,
      source: 'single_option',
      model: null,
      notes: '只有一个非尺码选项，无需拆分',
      products: input.colourOptions.length
        ? [{
          id: 'p1', name: input.title, options: [...input.colourOptions],
          imageIds: input.images.filter((image) => image.id).map((image) => String(image.id)),
          imageUrls: input.images.filter((image) => !image.id).map((image) => String(image.url)),
          ...sizesAndPriceForOptions(raw, input.colourOptions),
        }]
        : [],
      ignoredOptions: [],
      updatedAt: new Date().toISOString(),
    };
    return { input, plan: single };
  }
  const optionLines = input.colourOptions.map((text, index) => `${index + 1}. ${text}`).join('\n');
  const prompt = `你是电商商品变体拆分助手，只输出严格JSON，不要输出任何解释文字。
下面是一个 1688 商品：标题、颜色/款式选项文本、全部图片（主图/商品图/详情图/变体色卡，按顺序编号 图片1 到 图片${input.images.length}，已按顺序提供给你）。
把这些选项拆分成该链接里实际在卖的独立商品：
- 明显是同一类、只是颜色/花型/图案不同的选项，合并为同一个商品；
- 没有意义、不是商品的信息（例如"现货放心拍"、"包邮"、"新款热卖"等卖家文案）放入 ignoredOptions，不要作为商品；
- 如果所有选项本来就是同一类物件，只输出 1 个商品，不要硬拆；
- 必须结合图片判断：为每个拆分后的商品列出它展示的图片编号（商品图、详情图、色卡都可用；同一张图片可以同时归属多个商品）；无法确定时宁可少分。
输出格式：
{"products":[{"name":"中文短名","options":["选项原文"],"images":[1,2],"reason":"一句话"}],"ignoredOptions":["..."]}

标题：${JSON.stringify(input.title)}
选项文本：
${optionLines}
图片清单：
${input.images.map((image) => `${image.index}. ${image.label}`).join('\n')}`;

  const visionContent = [
    { type: 'text', text: prompt },
    ...input.images.map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
  ];
  let lastRaw = '';
  let lastProblem = 'no usable groups';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const content = attempt === 1
      ? visionContent
      : [...visionContent, {
        type: 'text',
        text: `上一次输出无法使用（${lastProblem}）。原文片段：${String(lastRaw).slice(0, 300)}
请重新输出：必须是严格 JSON，products 至少 1 项，options 必须逐字来自上面的选项列表，images 用给定编号，不要输出任何其他文字。`,
      }];
    const response = await fetch(endpointFrom(config.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(applyReasoning({
        model: config.model,
        messages: [{ role: 'user', content }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 384000,
      }, config.reasoningEffort)),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Split analysis failed (${response.status}): ${String(detail).slice(0, 200)}`);
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
    if (!parsed || !Array.isArray(parsed.products)) {
      lastProblem = 'JSON 无法解析或缺少 products';
      continue;
    }
    const { products, ignoredOptions } = normalisePlan(parsed.products, parsed.ignoredOptions, input, raw);
    if (!products.length) {
      lastProblem = '分组后没有有效产品（options 与选项列表不匹配或全为空）';
      continue;
    }
    return {
      input,
      plan: {
        version: 2,
        source: 'llm',
        model: config.model ?? null,
        products,
        ignoredOptions,
        updatedAt: new Date().toISOString(),
      },
    };
  }
  throw new Error(`Split analysis returned no usable groups: ${String(lastRaw).slice(0, 300)}`);
}

/** Recompute sizes/prices for a manually edited plan (authoritative server side). */
export function recomputePlan(plan, detail) {  const raw = detail?.raw_data ?? {};
  const products = (Array.isArray(plan?.products) ? plan.products : []).slice(0, MAX_PRODUCTS).map((product, index) => {
    const options = (Array.isArray(product?.options) ? product.options : [])
      .map(cleanText).filter(Boolean).slice(0, 60);
    const imageIds = [...new Set((Array.isArray(product?.imageIds) ? product.imageIds : [])
      .map((value) => String(value)).filter(Boolean))].slice(0, 60);
    const imageUrls = [...new Set((Array.isArray(product?.imageUrls) ? product.imageUrls : [])
      .map((value) => String(value)).filter(Boolean))].slice(0, 60);
    const { sizes, priceMax } = sizesAndPriceForOptions(raw, options);
    return {
      id: String(product?.id || `p${index + 1}`).slice(0, 16),
      name: cleanText(product?.name).slice(0, 80),
      options, imageIds, imageUrls, sizes, priceMax,
      reason: cleanText(product?.reason).slice(0, 200),
    };
  }).filter((product) => product.options.length || product.imageIds.length || product.imageUrls.length);
  return {
    version: 2,
    source: cleanText(plan?.source).slice(0, 20) || 'manual',
    model: plan?.model ?? null,
    notes: cleanText(plan?.notes).slice(0, 500),
    products,
    ignoredOptions: (Array.isArray(plan?.ignoredOptions) ? plan.ignoredOptions : [])
      .map(cleanText).filter(Boolean).slice(0, 60),
    updatedAt: new Date().toISOString(),
  };
}

// --- split product content generation ---------------------------------------

function imageLabelForRow(image) {
  if (image.image_type === 'main') return '主图';
  if (image.image_type === 'gallery') return '商品图';
  if (image.image_type === 'description') return '详情图';
  if (image.image_type === 'sku') return '变体色卡';
  return '图片';
}

/** Images that belong to one split product: its assignments + its own swatches. */
export function splitProductImages(detail, input, product, { baseUrl } = {}) {
  const byId = new Map((detail?.images ?? []).map((image) => [String(image.id), image]));
  const images = [];
  const seen = new Set();
  const push = (url, label) => {
    if (!url || seen.has(url) || images.length >= MAX_IMAGES) return;
    seen.add(url);
    images.push({ url, label, index: images.length + 1 });
  };
  for (const id of product?.imageIds ?? []) {
    const image = byId.get(String(id));
    if (!image) continue;
    const sourceUrl = /^https:\/\//i.test(image.source_url || '') ? cleanText(image.source_url) : null;
    push(sourceUrl || publicImageUrl(image.storage_path, baseUrl), imageLabelForRow(image));
  }
  for (const url of product?.imageUrls ?? []) push(cleanText(url), '详情图');
  for (const option of product?.options ?? []) {
    const match = (input?.images ?? []).find((image) => image.label === `变体色卡：${cleanText(option)}`);
    if (match) push(match.url, `变体色卡：${cleanText(option)}`);
  }
  return images;
}

const UPPER_SEGMENT = (value) => String(value).toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/** colour x size SKU rows for one split product, from the stored matrix. */
export function splitSkusForProduct(raw, product, codes, sizeTexts, prefix) {
  const colourSet = new Set((product?.options ?? []).map(cleanText));
  const rows = [];
  const used = new Map();
  for (const row of (Array.isArray(raw?.skuMatrix?.rows) ? raw.skuMatrix.rows : [])) {
    const options = row?.options ?? {};
    const colour = Object.values(options).map(cleanText).find((value) => colourSet.has(value));
    if (!colour) continue;
    const sizeEntry = Object.entries(options).find(([name]) => SIZE_RE.test(String(name)));
    const sizeSource = sizeEntry ? cleanText(sizeEntry[1]) : null;
    const code = codes.get(colour) ?? null;
    const sizeText = sizeSource ? (sizeTexts.get(sizeSource) ?? sizeSource) : null;
    const segments = [code, sizeText].filter(Boolean).map(UPPER_SEGMENT).filter(Boolean);
    if (!segments.length) continue;
    let sku = `${prefix}-${segments.join('-')}`;
    const count = (used.get(sku) ?? 0) + 1;
    used.set(sku, count);
    if (count > 1) sku = `${sku}-${count}`;
    rows.push({
      sku, colour, code, size: sizeSource, sizeText,
      price: Number.isFinite(Number(row?.price)) ? Number(row.price) : null,
      stock: Number.isFinite(Number(row?.stock)) ? Number(row.stock) : null,
      skuId: row?.skuId != null ? String(row.skuId) : null,
    });
  }
  return rows;
}

/** One content call per split product: title, description, variant names/codes, sizes. */
export async function generateSplitContents({ detail, plan, styleNo = null, config = {}, baseUrl }) {
  const raw = detail?.raw_data ?? {};
  const input = buildSplitInput(detail, { baseUrl });
  const products = (Array.isArray(plan?.products) ? plan.products : []).slice(0, MAX_PRODUCTS);
  if (!products.length) throw new Error('A saved split plan is required before generating content.');
  const contents = [];
  for (const [index, product] of products.entries()) {
    const images = splitProductImages(detail, input, product, { baseUrl });
    if (!images.length) {
      contents.push({
        id: product.id ?? `p${index + 1}`, name: product.name ?? null,
        title: null, description: null, colours: [], sizes: [], skus: [],
        images: { imageIds: product.imageIds ?? [], imageUrls: product.imageUrls ?? [] },
        needsReview: true, error: 'no_images_for_split_product',
      });
      continue;
    }
    const prompt = `你是电商B2B商品内容编辑，只输出严格JSON，不要输出解释。
下面是一个"拆分后的独立商品"（来自一个捆绑 listing），并已按顺序提供它自己的图片（图片1 到 图片${images.length}）。
输出内容：
- title：2–15 个英文单词的稳定产品名称；不得包含年份、平台名（Amazon/AliExpress/TikTok 等）、Hot Sale、Cross-Border、颜色、印花或图案词。
- description：35–120 个英文单词的单段产品级描述；只写多张图片共同体现的稳定可见特点（品类、轮廓、领型、肩带、罩杯结构、开合、覆盖度、剪裁、套装组成）；不得写颜色、印花、图案、单个 SKU、促销、年份、平台、SEO 关键词、穿着效果、材质、功能或不可见信息。
- colours：该商品的每个颜色/花色选项逐一输出（source 必须逐字使用给出的原文），给出简洁英文名 text（≤4 个单词）和 SKU 缩写 code（大写字母/数字/连字符，≤8 字符）。
- sizes：每个尺码逐一输出（source 逐字使用原文），给出标准英文标签 text（如 均码→One Size）。
输出格式：{"title":"","description":"","colours":[{"source":"原文","text":"英文名","code":"缩写"}],"sizes":[{"source":"原文","text":"标准英文"}]}

拆分商品参考名（中文）：${JSON.stringify(cleanText(product.name))}
颜色/花色选项（必须逐一覆盖）：${(product.options ?? []).map(cleanText).join(' | ') || '（无）'}
尺码（必须逐一覆盖）：${(product.sizes ?? []).map(cleanText).join(' / ') || '（无）'}`;
    const content = [
      { type: 'text', text: prompt },
      ...images.map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
    ];
    let parsed = null;
    let lastRaw = '';
    let lastProblem = 'no usable content';
    for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
      const messages = attempt === 1 ? [{ role: 'user', content }] : [{ role: 'user', content: [...content, {
        type: 'text',
        text: `上一次输出无法使用（${lastProblem}）。片段：${String(lastRaw).slice(0, 240)}。请重新输出严格 JSON，colours/sizes 必须逐一覆盖给定选项。`,
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
        throw new Error(`Split content failed (${response.status}): ${String(detailText).slice(0, 200)}`);
      }
      const payload = await response.json();
      const text = contentText(payload.choices?.[0]?.message?.content);
      lastRaw = text;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (!parsed) {
        const match = String(text || '').match(/\{[\s\S]*\}/);
        if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }
      }
      if (parsed && (!cleanText(parsed.title) || !cleanText(parsed.description))) {
        parsed = null;
        lastProblem = 'title/description 为空';
      }
      if (!parsed) lastProblem = lastProblem === 'no usable content' ? 'JSON 无法解析' : lastProblem;
    }
    if (!parsed) throw new Error(`Split content for ${product.id ?? index + 1} returned no usable result.`);
    const colourProposals = new Map((Array.isArray(parsed.colours) ? parsed.colours : [])
      .map((colour) => [cleanText(colour?.source), colour]));
    const usedCodes = new Set();
    const colours = (product.options ?? []).map((option) => {
      const proposal = colourProposals.get(cleanText(option)) ?? {};
      let code = UPPER_SEGMENT(cleanText(proposal.code)).slice(0, 12) || null;
      if (code) {
        const base = code;
        let suffix = 2;
        while (usedCodes.has(code)) { code = `${base}-${suffix}`; suffix += 1; }
        usedCodes.add(code);
      }
      const swatch = images.find((image) => image.label === `变体色卡：${cleanText(option)}`);
      return { source: cleanText(option), text: cleanText(proposal.text).slice(0, 60) || null, code, thumb: swatch?.url ?? null };
    });
    const sizeProposals = new Map((Array.isArray(parsed.sizes) ? parsed.sizes : [])
      .map((size) => [cleanText(size?.source), size]));
    const sizeTexts = new Map((product.sizes ?? []).map((size) => [cleanText(size), cleanText(sizeProposals.get(cleanText(size))?.text) || cleanText(size)]));
    const codeMap = new Map(colours.filter((colour) => colour.code).map((colour) => [colour.source, colour.code]));
    const prefix = styleNo ? `${styleNo}S${index + 1}` : `S${index + 1}`;
    const skus = splitSkusForProduct(raw, product, codeMap, sizeTexts, prefix);
    contents.push({
      id: product.id ?? `p${index + 1}`,
      name: cleanText(product.name) || null,
      title: cleanText(parsed.title).slice(0, 160) || null,
      description: cleanText(parsed.description).slice(0, 1200) || null,
      colours,
      sizes: (product.sizes ?? []).map((size) => ({
        source: cleanText(size), text: sizeTexts.get(cleanText(size)) ?? cleanText(size),
      })),
      skus,
      imageRefs: { imageIds: product.imageIds ?? [], imageUrls: product.imageUrls ?? [] },
      imageCount: images.length,
      needsReview: colours.some((colour) => !colour.text || !colour.code),
    });
  }
  return {
    input: { title: input.title, imageCount: input.images.length },
    contents: {
      version: 1,
      model: config.model ?? null,
      styleNo: styleNo ?? null,
      products: contents,
      updatedAt: new Date().toISOString(),
    },
  };
}
