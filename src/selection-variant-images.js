// Resolve a selection draft's colour/print variant images against its selected
// media. Swatch images stay independent: they are only visual evidence, never
// added to the gallery. The model is used only for colours whose swatch cannot
// be matched exactly, and it must choose one of the already-selected media URLs.

import { applyReasoning, DEFAULT_MAX_TOKENS } from './model-request.js';

const FALLBACK_BASE_URL = 'https://api.deepseek.com';
const MAX_IMAGES = 600;

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

function absoluteUrl(value, baseUrl) {
  const url = cleanText(value);
  if (!url) return null;
  if (/^https:\/\//i.test(url)) return url;
  if (/^http:\/\//i.test(url)) return `https://${url.slice(7)}`;
  if (/^\/\//.test(url)) return `https:${url}`;
  if (url.startsWith('/') && baseUrl) return `${String(baseUrl).replace(/\/+$/, '')}${url}`;
  return null;
}

/** URL comparison key tolerant of protocol, query strings and image-size suffixes. */
function imageKey(value) {
  let url = cleanText(value);
  if (!url) return '';
  try { url = new URL(url, 'https://placeholder.invalid').toString(); } catch { /* keep raw */ }
  return url
    .replace(/^http:/i, 'https:')
    .replace(/[?#].*$/, '')
    .replace(/_\d+x\d+([^/]*)$/i, '')
    .replace(/_\.webp$/i, '')
    .toLowerCase();
}

function colourOf(variant) {
  const options = variant?.optionValues && typeof variant.optionValues === 'object'
    ? variant.optionValues : {};
  for (const [key, value] of Object.entries(options)) {
    if (/(颜色|色|color|colour)/i.test(String(key)) && cleanText(value)) return cleanText(value);
  }
  return '';
}

function mediaForValue(media, value) {
  const key = imageKey(value);
  if (!key) return null;
  return media.find((entry) => imageKey(entry.url) === key || imageKey(entry.sourceUrl) === key) ?? null;
}

function mediaForSwatch(media, swatch) {
  if (!swatch) return null;
  const direct = mediaForValue(media, swatch.imageUrl) || mediaForValue(media, swatch.sourceUrl);
  if (direct) return direct;
  if (swatch.contentHash) {
    return media.find((entry) => entry.contentHash && entry.contentHash === swatch.contentHash) ?? null;
  }
  return null;
}

function buildColourList(draft) {
  const colours = [];
  const seen = new Set();
  const add = (value) => {
    const label = cleanText(value);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return;
    seen.add(key);
    const swatch = (draft.swatches ?? []).find((entry) => cleanText(entry?.value).toLowerCase() === key) ?? null;
    colours.push({ label, key, swatch });
  };
  for (const variant of Array.isArray(draft.variants) ? draft.variants : []) add(colourOf(variant));
  for (const swatch of Array.isArray(draft.swatches) ? draft.swatches : []) add(swatch?.value);
  return colours;
}

function imagePromptLine(image, index) {
  const alt = cleanText(image.alt);
  return `${index + 1}. ${alt || 'product image'}`;
}

async function askModel({ title, media, colours, config, publicBaseUrl }) {
  if (!config?.apiKey) return null;
  // Prefer the supplier source URL for model download. Collector-hosted image
  // URLs are public in a browser but are sometimes unreachable from the model
  // provider's fetcher; the WordPress/supplier source URL avoids that failure.
  // The provider requires an image it can read directly; inline JPEG previews
  // are the reliable transport. Skip derived media such as generated size
  // charts that have no local source image.
  const modelMedia = media
    .map((image) => ({ image, modelUrl: image.dataUrl || null }))
    .filter((entry) => entry.modelUrl);
  if (!modelMedia.length) return null;
  const mediaLines = modelMedia.map((entry, index) => imagePromptLine(entry, index)).join('\n');
  const colourLines = colours.map((colour) => `- ${colour.label}`).join('\n') || '（无颜色）';
  const model = config.visionModel || config.complexModel || 'deepseek-flash';
  const prompt = `你是电商商品变体图片匹配助手，只输出严格 JSON。
下面有商品标题、已选中的商品媒体图片（编号 1..${modelMedia.length}），以及需要匹配的颜色/花色名称。颜色名称可能来自色卡或卖家选项文本。
请为每个颜色从商品媒体图片中选择一张最能代表该颜色的图片，要求：
- 必须从 1..${modelMedia.length} 中选择，不能选择不存在的编号。
- 根据颜色名称和图片中商品的实际颜色/印花判断；不要优先选择与颜色明显不符的图片。
- 如果没有足够把握，mediaNumber 设为 null，confidence 低于 0.5。
- 不同颜色可以指向同一张图，但不要为了凑数强行选图。
输出格式：{"matches":[{"color":"颜色原文","mediaNumber":1,"confidence":0.9,"reason":"简短理由"}]}
颜色必须逐个覆盖，不要省略。

商品标题：${JSON.stringify(title || '')}
颜色：
${colourLines}
商品媒体图片：
${mediaLines}`;
  const content = [{ type: 'text', text: prompt }];
  for (const entry of modelMedia) content.push({ type: 'image_url', image_url: { url: entry.modelUrl } });
  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(applyReasoning({
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: DEFAULT_MAX_TOKENS,
    }, config.reasoningEffort)),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Variant image matching failed (${response.status}): ${String(detail).slice(0, 240)}`);
  }
  const payload = await response.json();
  const text = contentText(payload.choices?.[0]?.message?.content);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }
  }
  return {
    matches: Array.isArray(parsed?.matches) ? parsed.matches : [],
    media: modelMedia.map((entry) => entry.image),
  };
}

/**
 * Update variant images in a selection draft without adding swatch images to
 * the gallery. Every returned variant image is a selected media URL, so the
 * Portal publish path can pass it through to Shopify.
 */
export async function resolveSelectionVariantImages({ draft, sourceSwatches = [], config = {}, modelConfig = null }) {
  const payload = draft && typeof draft === 'object' ? structuredClone(draft) : {};
  delete payload.variantImageError;
  const media = (Array.isArray(payload.media) ? payload.media : [])
    .filter((entry) => entry?.url && entry.visible !== false)
    .map((entry) => ({ ...entry, url: absoluteUrl(entry.url, config.publicBaseUrl) || entry.url }));
  const sourceByColour = new Map((Array.isArray(sourceSwatches) ? sourceSwatches : [])
    .map((swatch) => [cleanText(swatch?.value).toLowerCase(), swatch])
    .filter(([key]) => key));
  const colours = buildColourList(payload);
  const matches = new Map();
  const unresolved = [];
  for (const colour of colours) {
    const variant = (Array.isArray(payload.variants) ? payload.variants : []).find((entry) => colourOf(entry).toLowerCase() === colour.key);
    const exact = mediaForSwatch(media, sourceByColour.get(colour.key))
      || mediaForSwatch(media, colour.swatch)
      || mediaForValue(media, variant?.imageUrl)
      || mediaForValue(media, variant?.sourceUrl);
    if (exact) {
      matches.set(colour.key, { colour: colour.label, url: exact.url, media: exact, confidence: 1, matchedBy: 'exact' });
    } else {
      unresolved.push({ ...colour, exact: false });
    }
  }
  let modelUsed = false;
  if (unresolved.length) {
    try {
      const result = await askModel({
        title: payload.title,
        media,
        colours: unresolved,
        publicBaseUrl: modelConfig?.publicBaseUrl ?? config.publicBaseUrl,
        config: {
          ...(modelConfig || {}),
          apiKey: modelConfig?.apiKey ?? config.modelApiKey,
          baseUrl: modelConfig?.baseUrl ?? config.modelBaseUrl,
          visionModel: modelConfig?.visionModel ?? config.visionModel,
          complexModel: modelConfig?.complexModel ?? config.complexModel,
          reasoningEffort: modelConfig?.reasoningEffort ?? config.reasoningEffort,
        },
      });
      modelUsed = Boolean(result?.matches?.length);
      for (const proposal of result?.matches ?? []) {
        const colour = unresolved.find((entry) => entry.key === cleanText(proposal?.color).toLowerCase());
        const number = Number(proposal?.mediaNumber);
        if (!colour || !Number.isInteger(number) || number < 1 || number > (result.media?.length ?? 0)) continue;
        const chosen = result.media[number - 1];
        if (!chosen?.url) continue;
        const confidence = Number(proposal?.confidence);
        matches.set(colour.key, {
          colour: colour.label,
          url: chosen.url,
          media: chosen,
          confidence: Number.isFinite(confidence) ? confidence : null,
          matchedBy: 'model',
          reason: cleanText(proposal?.reason).slice(0, 240),
        });
      }
    } catch (error) {
      payload.variantImageError = String(error?.message || error).slice(0, 500);
    }
  }
  const mediaUrls = new Set(media.map((entry) => imageKey(entry.url)));
  const swatchByColour = new Map();
  payload.swatches = (Array.isArray(payload.swatches) ? payload.swatches : []).map((swatch) => {
    const colour = cleanText(swatch?.value);
    const chosen = matches.get(colour.toLowerCase());
    if (!chosen?.url) return swatch;
    swatchByColour.set(colour.toLowerCase(), { ...swatch, imageUrl: chosen.url });
    return { ...swatch, imageUrl: chosen.url };
  });
  for (const [key, match] of matches) {
    if (swatchByColour.has(key)) continue;
    const swatch = { value: match.colour, color: null, imageUrl: match.url };
    payload.swatches.push(swatch);
    swatchByColour.set(key, swatch);
  }
  payload.variants = (Array.isArray(payload.variants) ? payload.variants : []).map((variant) => {
    const colour = colourOf(variant);
    const chosen = matches.get(colour.toLowerCase());
    if (chosen?.url) return { ...variant, imageUrl: chosen.url };
    if (!colour) {
      const current = mediaForValue(media, variant?.imageUrl);
      return { ...variant, imageUrl: current?.url ?? null };
    }
    const current = mediaForValue(media, variant?.imageUrl);
    return { ...variant, imageUrl: current?.url ?? null };
  });
  // Keep the original swatch URL as the colour identifier; it was never added
  // to media and is not used as variant media. Never persist inline model
  // previews in the draft payload.
  const stripPreview = ({ dataUrl, ...entry }) => entry;
  payload.media = Array.isArray(payload.media) ? payload.media.map(stripPreview) : payload.media;
  payload.swatches = Array.isArray(payload.swatches) ? payload.swatches.map(stripPreview) : payload.swatches;
  payload.variants = Array.isArray(payload.variants) ? payload.variants.map(stripPreview) : payload.variants;
  return {
    draft: payload,
    matches: [...matches.values()].map((entry) => ({
      color: entry.colour,
      imageUrl: entry.url,
      confidence: entry.confidence,
      matchedBy: entry.matchedBy,
      reason: entry.reason ?? null,
    })),
    modelUsed,
    unresolved: colours.filter((colour) => !matches.has(colour.key)).map((colour) => colour.label),
    mediaCount: media.length,
    mediaUrlCount: mediaUrls.size,
  };
}
