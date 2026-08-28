import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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

async function callVision(content, config, maxTokens = 2500) {
  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model || 'qwen3-vl-plus', messages: [{ role: 'user', content }], temperature: 0, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`DashScope gallery analysis failed (${response.status}).`);
  const payload = await response.json();
  const raw = contentText(payload.choices?.[0]?.message?.content);
  return { raw, parsed: parseJson(raw), usage: payload.usage ?? null };
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

/** Analyze an explicitly supplied, correctly ordered product gallery without database access. */
export async function analyzeGalleryImages({ images, config, persistOutput = false, offerId = 'test' }) {
  const gallery = (images || []).filter((image) => image.storage_path || image.path || image.dataUrl);
  if (!gallery.length) throw new Error('No locally stored product gallery images are available.');
  if (!config.apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');
  const storageRoot = path.resolve(config.storagePath || '/app/storage');
  const files = [];
  for (const [index, image] of gallery.entries()) {
    const imagePath = image.storage_path || image.path ? path.resolve(image.storage_path || image.path) : null;
    if (!image.dataUrl && (!imagePath || !imagePath.startsWith(`${storageRoot}${path.sep}`))) continue;
    const dataUrl = image.dataUrl || null;
    const bytes = dataUrl ? Buffer.from(dataUrl.split(',')[1] || '', 'base64') : await fs.readFile(imagePath);
    const ext = imagePath ? path.extname(imagePath).toLowerCase() : '';
    const mime = dataUrl?.match(/^data:([^;]+);/)?.[1] || ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || 'image/jpeg';
    files.push({ id: image.id ?? null, index, sourceUrl: image.source_url || image.sourceUrl || null, sourcePath: imagePath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:${mime};base64,${bytes.toString('base64')}` });
  }
  const prompt = `你是商品Gallery图片质检器。图片按网页展示顺序提供，图片0是首图。本轮不要判断重复，只返回严格JSON对象：{"items":[{"index":0,"is_front_view":true,"is_back_or_reverse":false,"is_collage":false,"has_watermark":false,"has_chinese_text":false,"notes":""}],"summary":""}。
判定规则：
1. is_front_view：展示商品正面；一套商品包含上下装不等于拼图。
2. is_back_or_reverse：展示服装背面、内里或反面。必须跨图片比较同一商品：例如其他图片显示印花外侧，而某图显示纯色内里、罩杯内侧、反面接缝或裤装背面，应标记true。局部特写或产品不完整本身绝不代表反面；如果局部图展示的印花外侧与其他正面图一致且没有明确内里证据，必须标记false。无法确认时也标记false并在notes说明。
3. is_collage：同一画布含独立分格、圆形局部放大框、多个重复视图或多张照片拼接。仅仅同时展示上装和下装不算拼接。
4. has_watermark：图片上叠加的品牌、店铺、平台、联系方式或水印文字/图标；正常场景道具不算水印。
5. has_chinese_text：图片画面中确实可见中文字符。
不要根据商品相同就推测其他属性，不可见信息不要编造。图片编号从0开始。\n${files.map((_, i) => `图片编号 ${i}`).join('、')}`;
  const content = [{ type: 'text', text: prompt }, ...files.map((file) => ({ type: 'image_url', image_url: { url: file.dataUrl } }))];
  const qualityResult = await callVision(content, config);
  const orientationPrompt = `你是服装正反面复核员。跨图片比较同一商品，只找出明确展示背面、内里或反面的图片。泳装中，若其他图显示印花外侧，而某图的对应部件显示纯色内里/反面，应列入；局部特写、不完整、不同花位本身不算反面。只返回严格JSON：{"back_or_reverse_indices":[1],"evidence":{"1":"与正面印花杯面对比，该图上装展示纯色内里"}}。没有明确证据则返回空数组。编号范围只能是0到${files.length - 1}。`;
  const orientationContent = [{ type: 'text', text: orientationPrompt }, ...files.map((file) => ({ type: 'image_url', image_url: { url: file.dataUrl } }))];
  const orientationResult = await callVision(orientationContent, config, 1000);
  const auditedBackIndices = new Set((Array.isArray(orientationResult.parsed?.back_or_reverse_indices)
    ? orientationResult.parsed.back_or_reverse_indices : []).map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < files.length));
  const duplicatePrompt = `你是图片取证去重器。严格比较以下编号图片，只判断是否源自同一张原始照片/完全相同构图。仅更换或抠除背景、改变格式、缩放、轻微裁切、添加局部放大框/文字覆盖，仍算重复。相同商品但不同角度、不同摆放、完整图与独立拍摄的局部特写绝对不算重复。只返回严格JSON：{"duplicate_sets":[{"indices":[0,2],"confidence":0.98,"evidence":"主体轮廓、褶皱和位置逐点一致，仅覆盖层不同"}],"summary":""}。没有高置信度重复则返回空数组；不要为了分组而强行判断。图片编号从0开始。`;
  const duplicateContent = [{ type: 'text', text: duplicatePrompt }, ...files.map((file) => ({ type: 'image_url', image_url: { url: file.dataUrl } }))];
  const duplicateResult = await callVision(duplicateContent, config, 1800);
  const parsed = qualityResult.parsed;
  const modelItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const byIndex = new Map(modelItems.map((item) => [Number(item.index), item]));
  const duplicateSets = Array.isArray(duplicateResult.parsed?.duplicate_sets)
    ? duplicateResult.parsed.duplicate_sets.map((set) => ({ ...set,
      indices: [...new Set((Array.isArray(set.indices) ? set.indices : []).map(Number)
        .filter((index) => Number.isInteger(index) && index >= 0 && index < files.length))],
    })).filter((set) => Number(set.confidence ?? 0) >= 0.85 && set.indices.length >= 2) : [];
  const duplicateGroupByIndex = new Map();
  for (const [groupIndex, set] of duplicateSets.entries()) {
    for (const index of set.indices.map(Number)) duplicateGroupByIndex.set(index, `visual:${groupIndex}`);
  }
  const prelim = files.map((file, index) => {
    const model = { ...(byIndex.get(index) || {}) };
    model.is_back_or_reverse = model.is_back_or_reverse === true || auditedBackIndices.has(index);
    if (auditedBackIndices.has(index) && !model.orientation_evidence) {
      model.orientation_evidence = orientationResult.parsed?.evidence?.[String(index)] || null;
    }
    const duplicateGroup = duplicateGroupByIndex.get(index) || `unique:${index}`;
    return { ...file, model, duplicateGroup, isBack: model.is_back_or_reverse === true };
  });
  const groupWinners = new Map();
  for (const item of prelim) {
    const exactGroup = `sha:${item.sha256}`;
    const group = prelim.some((other) => other !== item && other.sha256 === item.sha256)
      ? exactGroup : item.duplicateGroup;
    item.effectiveGroup = group;
    const penalty = (item.model.has_watermark === true ? 1000 : 0)
      + (item.model.has_chinese_text === true ? 1000 : 0)
      + (item.model.is_collage === true ? 100 : 0)
      + (item.isBack ? 10 : 0) + item.index / 100;
    const current = groupWinners.get(group);
    if (!current || penalty < current.penalty) groupWinners.set(group, { index: item.index, penalty });
  }
  const evaluated = prelim.map((file, index) => {
    const model = file.model;
    const groupMembers = prelim.filter((item) => item.effectiveGroup === file.effectiveGroup);
    const duplicate = groupMembers.length > 1 && groupWinners.get(file.effectiveGroup)?.index !== index;
    const reasons = [];
    if (model.has_watermark === true) reasons.push('watermark');
    if (model.has_chinese_text === true) reasons.push('chinese_text');
    if (duplicate) reasons.push('duplicate');
    if (index === 0 && model.is_front_view !== true) reasons.push('first_image_not_front');
    if (index === 0 && model.is_back_or_reverse === true) reasons.push('first_image_back_or_reverse');
    if (index === 0 && model.is_collage === true) reasons.push('first_image_collage');
    return { ...file, duplicate, reasons, passed: reasons.length === 0 };
  });
  const outputDir = path.join(storageRoot, 'product-images', String(offerId), 'clean-gallery');
  if (persistOutput) {
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });
  }
  const accepted = [];
  for (const item of evaluated.filter((entry) => entry.passed)) {
    const ext = item.sourcePath ? (path.extname(item.sourcePath) || '.jpg') : '.jpg';
    const outputPath = path.join(outputDir, `${String(accepted.length).padStart(4, '0')}-${item.sha256.slice(0, 12)}${ext}`);
    if (persistOutput && item.sourcePath) await fs.copyFile(item.sourcePath, outputPath);
    accepted.push({ imageId: item.id, sourceUrl: item.sourceUrl, sourcePath: item.sourcePath,
      cleanPath: persistOutput ? outputPath : null, sortOrder: accepted.length });
  }
  const invalidCount = evaluated.filter((item) => item.reasons.some((reason) =>
    ['watermark', 'chinese_text', 'first_image_not_front', 'first_image_back_or_reverse', 'first_image_collage'].includes(reason))).length;
  const status = !evaluated[0]?.passed || invalidCount > 0
    ? 'failed'
    : (evaluated.some((item) => item.isBack) ? 'passed_with_warnings' : 'passed');
  return {
    model: config.model || 'qwen3-vl-plus', galleryCount: files.length,
    acceptedCount: accepted.length, invalidCount, status,
    firstImagePassed: evaluated[0]?.passed === true,
    backImageWarning: evaluated.some((item) => item.isBack),
    items: evaluated.map(({ dataUrl, ...item }) => item), accepted,
    validatedDuplicateSets: duplicateSets,
    modelResponse: { quality: qualityResult, orientation: orientationResult, duplicates: duplicateResult },
  };
}

/** Backward-compatible persisted flow used after the test-stage rules are accepted. */
export async function cleanProductGallery({ detail, config }) {
  const images = (detail.images || []).sort((a, b) => {
    if (a.image_type === 'main') return -1;
    if (b.image_type === 'main') return 1;
    return (a.sort_order || 0) - (b.sort_order || 0);
  });
  return analyzeGalleryImages({ images, config, persistOutput: true, offerId: detail.offer_id || detail.id });
}
