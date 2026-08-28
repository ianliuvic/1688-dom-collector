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

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

/** Analyze an explicitly supplied, correctly ordered product gallery without database access. */
export async function analyzeGalleryImages({ images, config, persistOutput = false, offerId = 'test' }) {
  const gallery = (images || []).filter((image) => image.storage_path || image.path);
  if (!gallery.length) throw new Error('No locally stored product gallery images are available.');
  if (!config.apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');
  const storageRoot = path.resolve(config.storagePath || '/app/storage');
  const files = [];
  for (const [index, image] of gallery.entries()) {
    const imagePath = path.resolve(image.storage_path || image.path);
    if (!imagePath.startsWith(`${storageRoot}${path.sep}`)) continue;
    const bytes = await fs.readFile(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || 'image/jpeg';
    files.push({ id: image.id ?? null, index, sourceUrl: image.source_url || image.sourceUrl || null, sourcePath: imagePath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:${mime};base64,${bytes.toString('base64')}` });
  }
  const prompt = `你是商品Gallery图片质检器。图片按网页展示顺序提供，图片0是首图。只返回严格JSON对象：{"items":[{"index":0,"is_front_view":true,"is_back_or_reverse":false,"is_collage":false,"has_watermark":false,"has_chinese_text":false,"duplicate_group":"g0","notes":""}],"summary":""}。
判定规则：
1. is_front_view：展示商品正面；一套商品包含上下装不等于拼图。
2. is_back_or_reverse：展示服装背面、内里或反面，无法确认时为false。
3. is_collage：同一画布含独立分格、圆形局部放大框、多个重复视图或多张照片拼接。仅仅同时展示上装和下装不算拼接。
4. has_watermark：图片上叠加的品牌、店铺、平台、联系方式或水印文字/图标；正常场景道具不算水印。
5. has_chinese_text：图片画面中确实可见中文字符。
6. duplicate_group必须非常严格：只有同一张原始照片/同一构图的复用才使用相同组名，包括仅更换/抠除背景、改变文件格式、轻微裁切或缩放。相同商品的不同角度、完整图与局部特写、不同摆放方式必须使用不同组名。
不要根据商品相同就判重复，不可见信息不要编造。图片编号从0开始。\n${files.map((_, i) => `图片编号 ${i}`).join('、')}`;
  const content = [{ type: 'text', text: prompt }, ...files.map((file) => ({ type: 'image_url', image_url: { url: file.dataUrl } }))];
  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model || 'qwen3-vl-plus', messages: [{ role: 'user', content }], temperature: 0, max_tokens: 2500 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`DashScope gallery analysis failed (${response.status}).`);
  const payload = await response.json();
  const rawContent = contentText(payload.choices?.[0]?.message?.content);
  const parsed = parseJson(rawContent);
  const modelItems = Array.isArray(parsed?.items) ? parsed.items : [];
  const byIndex = new Map(modelItems.map((item) => [Number(item.index), item]));
  const seenGroups = new Set();
  const evaluated = files.map((file, index) => {
    const model = byIndex.get(index) || {};
    const duplicateGroup = String(model.duplicate_group || `sha:${file.sha256}`);
    const exactDuplicate = files.findIndex((candidate) => candidate.sha256 === file.sha256) !== index;
    const duplicate = seenGroups.has(duplicateGroup) || exactDuplicate;
    seenGroups.add(duplicateGroup);
    const reasons = [];
    if (model.has_watermark === true) reasons.push('watermark');
    if (model.has_chinese_text === true) reasons.push('chinese_text');
    if (duplicate) reasons.push('duplicate');
    if (index === 0 && model.is_front_view !== true) reasons.push('first_image_not_front');
    if (index === 0 && model.is_back_or_reverse === true) reasons.push('first_image_back_or_reverse');
    if (index === 0 && model.is_collage === true) reasons.push('first_image_collage');
    return { ...file, model, duplicateGroup, duplicate, reasons,
      isBack: model.is_back_or_reverse === true, passed: reasons.length === 0 };
  });
  const outputDir = path.join(storageRoot, 'product-images', String(offerId), 'clean-gallery');
  if (persistOutput) {
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });
  }
  const accepted = [];
  for (const item of evaluated.filter((entry) => entry.passed)) {
    const ext = path.extname(item.sourcePath) || '.jpg';
    const outputPath = path.join(outputDir, `${String(accepted.length).padStart(4, '0')}-${item.sha256.slice(0, 12)}${ext}`);
    if (persistOutput) await fs.copyFile(item.sourcePath, outputPath);
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
    modelResponse: { raw: rawContent, parsed, usage: payload.usage ?? null },
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
