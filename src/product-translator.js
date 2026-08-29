import crypto from 'node:crypto';

const ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

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
  return translated;
}

export async function translateProductDetail({ detail, targetLanguage = 'en', config }) {
  if (!config?.apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');
  if (targetLanguage !== 'en') throw new Error('Only English translation is currently supported.');
  const source = buildProductTranslationSource(detail);
  const model = config.complexModel || 'qwen3.8-max';
  const outputShape = {
    title: '', description: '', sellerName: '',
    attributes: source.attributes.map((item) => ({ index: item.index, name: '', value: '' })),
    skuDimensions: source.skuDimensions.map((item) => ({ index: item.index, name: '', values: item.values.map(() => '') })),
    skuOptions: source.skuOptions.map((item) => ({ index: item.index, text: '', imageUrl: item.imageUrl })),
    skuRows: source.skuRows.map((item) => ({ index: item.index, skuKey: item.skuKey, skuText: '', options: {} })),
    priceTextCandidates: source.priceTextCandidates.map(() => ''),
  };
  const prompt = `你是专业的泳装和服装B2B商品数据翻译器。把输入JSON中的中文商品文本准确翻译为自然、简洁、适合国际批发目录的英文，并只返回严格JSON。
要求：
1. 严格使用给定输出结构；所有数组数量、index、skuKey、imageUrl和原始顺序必须保持不变。
2. 不添加卖点，不猜测材质、工艺、品牌、颜色或产品组成；原文含糊时忠实翻译。
3. 保留款号、品牌名、数字、S/M/L/XL、罩杯、单位、货币和行业缩写；不要换算价格、库存、尺码或单位。
4. SKU options对象的键和值都翻译；skuText翻译，但skuKey原样保留。
5. 颜色、印花、部件、单件/套装、现货/预售等用电商行业自然英文表达。
6. 空字符串保持空字符串。不要输出Markdown、解释、原文对照或JSON之外的内容。
目标语言：English。
输出结构：${JSON.stringify(outputShape)}
输入JSON：${JSON.stringify(source)}`;
  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 12000 }),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) throw new Error(`DashScope product translation failed (${response.status}).`);
  const payload = await response.json();
  const raw = contentText(payload.choices?.[0]?.message?.content);
  const translated = validateProductTranslation(source, parseJson(raw));
  return {
    schemaVersion: 1, sourceLanguage: 'zh-CN', targetLanguage, model,
    sourceHash: translationSourceHash(source), source, translated,
    usage: payload.usage ?? null,
  };
}
