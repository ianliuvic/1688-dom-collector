// Semantic bundle classification.
//
// Instead of enumerating colour-word rules, hand the captured variant option
// texts to the model and let it decide whether the options describe one garment
// in several variants or several different garments in one listing. The
// rule-based detector stays as a fallback when the model is unavailable.

import { applyReasoning } from './model-request.js';

const FALLBACK_BASE_URL = 'https://api.deepseek.com';
const SIZE_NAME_RE = /(尺码|尺寸|码数|size)/i;

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

/** Ordered {name, values[]} dimensions from skuOptions (preferred) or skuDimensions. */
export function collectVariantDimensions(data) {
  const dimensions = [];
  const index = new Map();
  const add = (name, values) => {
    const key = String(name || '').trim();
    if (!key) return;
    if (!index.has(key)) { index.set(key, []); dimensions.push({ name: key, values: index.get(key) }); }
    const target = index.get(key);
    for (const value of values) {
      const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
      if (clean && !target.includes(clean)) target.push(clean);
    }
  };
  for (const option of Array.isArray(data?.skuOptions) ? data.skuOptions : []) {
    add(option?.dimensionName, [option?.text]);
  }
  if (!dimensions.length) {
    for (const dimension of Array.isArray(data?.skuDimensions) ? data.skuDimensions : []) {
      add(dimension?.name, Array.isArray(dimension?.values) ? dimension.values : []);
    }
  }
  return dimensions;
}

export function bundleClassifierConfig(config = {}) {
  return {
    apiKey: config.modelApiKey,
    baseUrl: config.modelBaseUrl,
    model: config.complexModel,
    reasoningEffort: config.reasoningEffort,
  };
}

/** Classification failed and there is no previous verdict to preserve. */
export function failedBundleDetection(error) {
  return {
    status: null,
    analysis: {
      detector: 'llm_error',
      checkedAt: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 200),
    },
  };
}

/**
 * Ask the model whether one capture mixes different garments. Returns the same
 * shape as the rule detector: { status, analysis }.
 */
export async function classifyBundleSemantically({ data, title = '', config = {} }) {
  const dimensions = collectVariantDimensions(data);
  const nonSize = dimensions.filter((dimension) => dimension.name && !SIZE_NAME_RE.test(dimension.name));
  const sizeDimensions = dimensions.filter((dimension) => SIZE_NAME_RE.test(dimension.name));
  const distinctOptions = new Set(nonSize.flatMap((dimension) => dimension.values));
  const baseAnalysis = {
    detector: 'llm_semantic',
    checkedAt: new Date().toISOString(),
    dimensions: dimensions.map((dimension) => ({ name: dimension.name, values: dimension.values })),
  };
  if (distinctOptions.size <= 1) {
    return {
      status: 'clear',
      analysis: {
        ...baseAnalysis,
        reason: '只有一个非尺码选项，无法构成混装',
        groups: [[...distinctOptions]],
      },
    };
  }
  const lines = nonSize.map((dimension) => `${dimension.name}：${dimension.values.join(' | ')}`);
  if (sizeDimensions.length) {
    lines.push(`尺码维度（仅供参考）：${sizeDimensions.map((d) => d.values.join('/')).join('；')}`);
  }
  const prompt = `你是电商商品选项审校助手，只输出严格JSON。
商品标题：${JSON.stringify(String(title || '').slice(0, 140))}
选项文本：
${lines.join('\n')}

判断这些选项属于"同一件商品的不同颜色/款式"，还是"同一个链接里混装了不同种类的商品"？
判定口径：货号、颜色叫法（包含 抹茶色、香槟色、卡其 这类非常规写法）、花型图案、卖家文案（现货、放心拍、包邮等）都算同一件商品；只有出现两种以上不同的"物件"（例如 比基尼 vs 罩衫、泳衣 vs 裙子、上衣 vs 裤子、套装 vs 单件）才算混装。
只输出：{"bundle": true或false, "groups": [["选项A","选项B"],["选项C"]], "reason": "一句话中文理由"}`;

  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(applyReasoning({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 384000,
    }, config.reasoningEffort)),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Bundle classification failed (${response.status}).`);
  const payload = await response.json();
  const raw = contentText(payload.choices?.[0]?.message?.content);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed) {
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }
  if (!parsed || typeof parsed.bundle !== 'boolean') {
    throw new Error('Bundle classification returned no verdict.');
  }
  return {
    status: parsed.bundle ? 'bundle' : 'clear',
    analysis: {
      ...baseAnalysis,
      model: config.model,
      reason: String(parsed.reason || '').slice(0, 300),
      groups: Array.isArray(parsed.groups)
        ? parsed.groups.map((group) => (Array.isArray(group) ? group.map(String) : [])).slice(0, 10)
        : null,
    },
  };
}
