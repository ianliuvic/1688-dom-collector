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
const MAX_IMAGES = 24;
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

/** Colour/option texts and the ordered main+gallery images for one detail. */
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
  const images = (detail?.images ?? [])
    .filter((image) => image.image_type === 'main' || image.image_type === 'gallery')
    .sort((left, right) => {
      if (left.image_type !== right.image_type) return left.image_type === 'main' ? -1 : 1;
      return Number(left.sort_order) - Number(right.sort_order);
    })
    .map((image, index) => {
      // Prefer the original CDN URL (the same source the translator uses, which
      // the vision provider reliably accepts), fall back to our hosted copy.
      const sourceUrl = /^https:\/\//i.test(image.source_url || '') ? cleanText(image.source_url) : null;
      const url = sourceUrl || publicImageUrl(image.storage_path, baseUrl) || null;
      return { id: String(image.id), type: image.image_type, sortOrder: Number(image.sort_order) || 0, url, index: index + 1 };
    })
    .filter((image) => image.url)
    .slice(0, MAX_IMAGES);
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

function normalisePlan(products, ignoredOptions, input, raw) {
  const seen = new Set();
  const result = [];
  for (const product of products.slice(0, MAX_PRODUCTS)) {
    const optionTexts = (Array.isArray(product?.options) ? product.options : [])
      .map(cleanText)
      .filter((text) => input.colourOptions.includes(text) && !seen.has(text));
    if (!optionTexts.length) continue;
    optionTexts.forEach((text) => seen.add(text));
    const imageIds = (Array.isArray(product?.images) ? product.images : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= input.images.length)
      .map((value) => input.images[value - 1].id);
    const { sizes, priceMax } = sizesAndPriceForOptions(raw, optionTexts);
    result.push({
      id: `p${result.length + 1}`,
      name: cleanText(product?.name).slice(0, 80) || optionTexts[0],
      options: optionTexts,
      imageIds: [...new Set(imageIds)],
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
          imageIds: input.images.map((image) => image.id), ...sizesAndPriceForOptions(raw, input.colourOptions),
        }]
        : [],
      ignoredOptions: [],
      updatedAt: new Date().toISOString(),
    };
    return { input, plan: single };
  }
  const optionLines = input.colourOptions.map((text, index) => `${index + 1}. ${text}`).join('\n');
  const prompt = `你是电商商品变体拆分助手，只输出严格JSON，不要输出任何解释文字。
下面是一个 1688 商品：标题、颜色/款式选项文本、商品图片（按顺序编号 图片1 到 图片${input.images.length}，已按顺序提供给你）。
把这些选项拆分成该链接里实际在卖的独立商品：
- 明显是同一类、只是颜色/花型/图案不同的选项，合并为同一个商品；
- 没有意义、不是商品的信息（例如"现货放心拍"、"包邮"、"新款热卖"等卖家文案）放入 ignoredOptions，不要作为商品；
- 如果所有选项本来就是同一类物件，只输出 1 个商品，不要硬拆；
- 必须结合图片判断：为每个拆分后的商品列出它展示的图片编号；同一张图片可以同时归属多个商品；无法确定时宁可少分。
输出格式：
{"products":[{"name":"中文短名","options":["选项原文"],"images":[1,2],"reason":"一句话"}],"ignoredOptions":["..."]}

标题：${JSON.stringify(input.title)}
选项文本：
${optionLines}
图片清单：
${input.images.map((image) => `${image.index}. ${image.type}`).join('\n')}`;

  const content = [
    { type: 'text', text: prompt },
    ...input.images.map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
  ];
  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(applyReasoning({
      model: config.model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 3000,
    }, config.reasoningEffort)),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Split analysis failed (${response.status}): ${String(detail).slice(0, 200)}`);
  }
  const payload = await response.json();
  const text = contentText(payload.choices?.[0]?.message?.content);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }
  }
  if (!parsed || !Array.isArray(parsed.products)) {
    throw new Error('Split analysis returned no usable groups.');
  }
  const { products, ignoredOptions } = normalisePlan(parsed.products, parsed.ignoredOptions, input, raw);
  if (!products.length) throw new Error('Split analysis returned no products.');
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

/** Recompute sizes/prices for a manually edited plan (authoritative server side). */
export function recomputePlan(plan, detail) {
  const raw = detail?.raw_data ?? {};
  const products = (Array.isArray(plan?.products) ? plan.products : []).slice(0, MAX_PRODUCTS).map((product, index) => {
    const options = (Array.isArray(product?.options) ? product.options : [])
      .map(cleanText).filter(Boolean).slice(0, 60);
    const imageIds = [...new Set((Array.isArray(product?.imageIds) ? product.imageIds : [])
      .map((value) => String(value)).filter(Boolean))].slice(0, 60);
    const { sizes, priceMax } = sizesAndPriceForOptions(raw, options);
    return {
      id: String(product?.id || `p${index + 1}`).slice(0, 16),
      name: cleanText(product?.name).slice(0, 80),
      options, imageIds, sizes, priceMax,
      reason: cleanText(product?.reason).slice(0, 200),
    };
  }).filter((product) => product.options.length || product.imageIds.length);
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
