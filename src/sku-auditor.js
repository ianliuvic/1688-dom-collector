const ENDPOINT = 'https://api.deepseek.com/chat/completions';

const AVAILABILITY_RE = /(现货|有货|预售|缺货|补货|下单|联系客服|咨询客服|拍下|备注|随机发|不退不换)/i;
const MODEL_CODE_RE = /(?:^|[\s_-])(?:[A-Z]{1,5}\d{2,}|\d{3,}[A-Z]{0,4})(?:$|[\s_-])/i;
const STANDARD_SIZE_RE = /^(?:X{0,4}S|S|M|L|X{1,5}L|[2-5]XL|均码|ONE\s*SIZE|FREE\s*SIZE|\d{2,3}(?:\.5)?|\d{2,3}[A-Z]?|[A-Z]\d{2,3})$/i;
const SIZE_RANK = new Map(['XXXXS', 'XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL']
  .map((value, index) => [value, index]));

function endpointFrom(baseUrl) {
  const base = String(baseUrl || ENDPOINT).replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}/chat/completions`;
}

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { return null; }
}

function contentText(content) {
  return Array.isArray(content) ? content.map((part) => part?.text || '').join('') : String(content || '');
}

function dimensionKind(name) {
  const value = clean(name).toLowerCase();
  if (/(尺码|尺寸|size|码数)/i.test(value)) return 'size';
  if (/(颜色|花色|款式|图案|color|colour|pattern|style)/i.test(value)) return 'variant';
  return 'unknown';
}

function sizeRank(value) {
  let normalized = clean(value).toUpperCase().replace(/\s+/g, '');
  const numberedXl = normalized.match(/^([2-5])XL$/);
  if (numberedXl) normalized = `${'X'.repeat(Number(numberedXl[1]))}L`;
  if (SIZE_RANK.has(normalized)) return SIZE_RANK.get(normalized);
  if (/^\d+(?:\.5)?$/.test(normalized)) return 100 + Number(normalized);
  return null;
}

/** Deterministic warnings are exported so the audit can be tested without calling a model. */
export function auditSkuRules(product = {}) {
  const dimensions = Array.isArray(product.skuDimensions) ? product.skuDimensions : [];
  const rows = Array.isArray(product.skuRows) ? product.skuRows : [];
  const options = Array.isArray(product.skuOptions) ? product.skuOptions : [];
  const warnings = [];
  const dimensionAudit = dimensions.map((dimension, dimensionIndex) => {
    const name = clean(dimension?.name);
    const kind = dimensionKind(name);
    const values = (Array.isArray(dimension?.values) ? dimension.values : []).map(clean);
    const seen = new Set();
    const duplicates = values.filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    const availabilityValues = values.filter((value) => AVAILABILITY_RE.test(value));
    const nonstandardSizes = kind === 'size' ? values.filter((value) => !STANDARD_SIZE_RE.test(value)) : [];
    const ranks = kind === 'size' ? values.map(sizeRank) : [];
    const comparableRanks = ranks.filter((rank) => rank !== null);
    const outOfOrder = kind === 'size' && comparableRanks.length === values.length
      && comparableRanks.some((rank, index) => index > 0 && rank < comparableRanks[index - 1]);
    if (!name) warnings.push({ code: 'missing_dimension_name', severity: 'warning', dimensionIndex });
    if (values.some((value) => !value)) warnings.push({ code: 'empty_option_name', severity: 'warning', dimensionIndex });
    if (duplicates.length) warnings.push({ code: 'duplicate_option_names', severity: 'warning', dimensionIndex, values: [...new Set(duplicates)] });
    if (availabilityValues.length) warnings.push({ code: 'availability_used_as_option', severity: 'warning', dimensionIndex, values: availabilityValues });
    if (nonstandardSizes.length) warnings.push({ code: 'nonstandard_size_names', severity: 'review', dimensionIndex, values: nonstandardSizes });
    if (outOfOrder) warnings.push({ code: 'size_order_unusual', severity: 'review', dimensionIndex, values });
    return { index: dimensionIndex, originalName: name, inferredKind: kind, originalValues: values,
      duplicateValues: [...new Set(duplicates)], availabilityValues, nonstandardSizes, outOfOrder };
  });

  const optionAudit = options.map((option, index) => {
    const text = clean(option?.text);
    const hasImage = Boolean(option?.image);
    const issues = [];
    if (!text) issues.push('missing_name');
    if (AVAILABILITY_RE.test(text)) issues.push('availability_text');
    if (MODEL_CODE_RE.test(` ${text} `)) issues.push('possible_model_code');
    return { index, originalText: text, originalImageUrl: option?.image || null, hasImage, issues };
  });
  if (optionAudit.length && optionAudit.every((item) => !item.hasImage)) {
    warnings.push({ code: 'all_variant_images_missing', severity: 'review' });
  } else if (optionAudit.some((item) => !item.hasImage)) {
    warnings.push({ code: 'some_variant_images_missing', severity: 'review',
      indices: optionAudit.filter((item) => !item.hasImage).map((item) => item.index) });
  }
  for (const item of optionAudit.filter((entry) => entry.issues.includes('availability_text'))) {
    warnings.push({ code: 'availability_used_as_variant_name', severity: 'warning', optionIndex: item.index, value: item.originalText });
  }
  const rowAudit = rows.map((row, index) => {
    const issues = [];
    if (row?.price === null || row?.price === undefined || row?.price === '') issues.push('missing_price');
    if (row?.stock === null || row?.stock === undefined || row?.stock === '') issues.push('missing_stock');
    const optionMap = row?.options && typeof row.options === 'object' ? row.options : {};
    if (!Object.keys(optionMap).length && !clean(row?.skuText)) issues.push('missing_combination');
    if (issues.length) warnings.push({ code: 'incomplete_sku_row', severity: 'warning', rowIndex: index, issues });
    return { index, original: row, issues };
  });
  return { dimensions: dimensionAudit, options: optionAudit, rows: rowAudit, warnings };
}

async function callComplexModel(content, config) {
  const model = config.complexModel || 'deepseek-v4-flash-vision-exp';
  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 5000 }),
    signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) throw new Error(`DeepSeek SKU audit failed (${response.status}).`);
  const payload = await response.json();
  const raw = contentText(payload.choices?.[0]?.message?.content);
  return { model, raw, parsed: parseJson(raw), usage: payload.usage ?? null };
}

/** Analyze irregular 1688 variants without changing, filtering, or normalizing the source data. */
export async function auditProductSkus({ product, skuImages = [], galleryImages = [], config }) {
  if (!config?.apiKey) throw new Error('DEEPSEEK_API_KEY is not configured.');
  const rules = auditSkuRules(product);
  const imageParts = [];
  const imageManifest = [];
  for (const item of [...skuImages, ...galleryImages.slice(0, 4)].slice(0, 30)) {
    if (!item?.dataUrl) continue;
    const label = item.kind === 'gallery' ? `gallery:${item.index}` : `sku-option:${item.optionIndex}`;
    imageManifest.push({ label, sourceUrl: item.sourceUrl || null, optionText: item.optionText || null });
    imageParts.push({ type: 'text', text: `下一张图片标签：${label}` },
      { type: 'image_url', image_url: { url: item.dataUrl } });
  }
  const source = {
    offerId: product.offerId ?? null,
    title: product.title ?? '',
    attributes: product.attributes ?? [],
    skuDimensions: product.skuDimensions ?? [],
    skuRows: product.skuRows ?? [],
    skuOptions: (product.skuOptions ?? []).map((item, index) => ({ index, text: item.text, imageUrl: item.image || null })),
    deterministicWarnings: rules.warnings,
    imageManifest,
  };
  const prompt = `你是1688商品SKU结构审计器。只审计，不得删除、改写、合并或重新排序任何原始SKU。结合标题、属性、SKU结构和带标签图片，返回严格JSON：
{"summary":{"has_missing_variant_images":false,"has_text_image_mismatch":false,"has_nonstandard_variant_names":false,"has_multiple_products":false,"has_bundle_options":false,"has_nonstandard_sizes":false,"requires_review":false},"dimensions":[{"index":0,"semantic_type":"color|pattern|style|component|bundle|size|availability|model_code|customization|unknown","confidence":0.0,"evidence":""}],"variants":[{"option_index":0,"original_text":"","image_label":"sku-option:0","semantic_type":"color|pattern|style|component|bundle|availability|model_code|customization|unknown","text_image_match":"match|mismatch|not_assessable","suggested_label":null,"confidence":0.0,"evidence":""}],"sizes":[{"original":"","standardized_suggestion":null,"is_standard":true,"confidence":0.0,"evidence":""}],"warnings":[{"code":"","severity":"info|warning|review","scope":"","evidence":"","confidence":0.0}]}
重点判断：SKU图文是否一致；文字是否只是现货/预售等库存状态；是否为款号+颜色；同页是否混卖多个不同产品；是否混用单件、套装、组合；尺码含义、顺序和非标准名称。图片缺失时必须写 not_assessable，绝不猜测图文关系。suggested_label 只是建议，不能声称已修改。证据不足时降低置信度并要求人工复核。
输入数据：${JSON.stringify(source)}`;
  const result = await callComplexModel([{ type: 'text', text: prompt }, ...imageParts], config);
  const modelAudit = result.parsed || { summary: { requires_review: true }, dimensions: [], variants: [], sizes: [],
    warnings: [{ code: 'model_response_not_json', severity: 'review', scope: 'product', evidence: result.raw.slice(0, 500), confidence: 1 }] };
  const modelWarnings = Array.isArray(modelAudit.warnings) ? modelAudit.warnings : [];
  const warnings = [...rules.warnings.map((warning) => ({ ...warning, source: 'rules' })),
    ...modelWarnings.map((warning) => ({ ...warning, source: result.model }))];
  const modelSummary = modelAudit.summary && typeof modelAudit.summary === 'object' ? modelAudit.summary : {};
  const requiresReview = warnings.length > 0 || Object.values(modelSummary).some((value) => value === true);
  return {
    schemaVersion: 1,
    mode: 'audit_only',
    models: { vision: config.visionModel || 'deepseek-v4-flash-vision-exp', complex: result.model },
    auditStatus: requiresReview ? 'issues_detected' : 'clear',
    summary: { ...modelSummary, requiresReview },
    source: { offerId: product.offerId ?? null, title: product.title ?? null,
      skuDimensions: product.skuDimensions ?? [], skuRows: product.skuRows ?? [], skuOptions: product.skuOptions ?? [] },
    ruleAudit: rules,
    dimensions: Array.isArray(modelAudit.dimensions) ? modelAudit.dimensions : [],
    variants: Array.isArray(modelAudit.variants) ? modelAudit.variants : [],
    sizes: Array.isArray(modelAudit.sizes) ? modelAudit.sizes : [],
    warnings,
    modelResponse: result,
  };
}
