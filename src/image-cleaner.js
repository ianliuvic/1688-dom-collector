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

/** Analyze gallery images and copy the passing, deduplicated set into persistent storage. */
export async function cleanProductGallery({ detail, config }) {
  const gallery = (detail.images || [])
    .filter((image) => image.image_type === 'gallery' && image.storage_path)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (!gallery.length) throw new Error('No locally stored gallery images are available.');
  if (!config.apiKey) throw new Error('DASHSCOPE_API_KEY is not configured.');
  const storageRoot = path.resolve(config.storagePath || '/app/storage');
  const files = [];
  for (const [index, image] of gallery.entries()) {
    const imagePath = path.resolve(image.storage_path);
    if (!imagePath.startsWith(`${storageRoot}${path.sep}`)) continue;
    const bytes = await fs.readFile(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || 'image/jpeg';
    files.push({ id: image.id, index, sourceUrl: image.source_url, sourcePath: imagePath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:${mime};base64,${bytes.toString('base64')}` });
  }
  const prompt = `你是商品图片质检器。按图片编号逐一分析以下产品gallery图片，只返回严格JSON对象：{"items":[{"index":0,"is_front_single":true,"is_back":false,"is_collage":false,"has_watermark":false,"has_chinese_text":false,"duplicate_group":"g0","notes":""}],"summary":""}。规则：is_front_single 仅当产品正面、单张完整产品图且不是拼接图时为true；背面图标记is_back；多图拼接/分格/组合图标记is_collage；任何可见品牌/店铺/平台/联系方式等水印标记has_watermark；图片内出现任何中文字符标记has_chinese_text。duplicate_group：视觉上相同产品图应使用相同组名，即使仅背景颜色不同；完全不同图片使用不同组名。不要根据文件名猜测，不可见的信息不要编造。图片编号从0开始。\n${files.map((_, i) => `图片编号 ${i}`).join('、')}`;
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
    if (model.is_collage === true) reasons.push('collage');
    if (duplicate) reasons.push('duplicate');
    if (index === 0 && model.is_front_single !== true) reasons.push('first_image_not_front_single');
    return { ...file, model, duplicateGroup, duplicate, reasons,
      isBack: model.is_back === true, passed: reasons.length === 0 };
  });
  const outputDir = path.join(storageRoot, 'product-images', String(detail.offer_id || detail.id), 'clean-gallery');
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const accepted = [];
  for (const item of evaluated.filter((entry) => entry.passed)) {
    const ext = path.extname(item.sourcePath) || '.jpg';
    const outputPath = path.join(outputDir, `${String(accepted.length).padStart(4, '0')}-${item.sha256.slice(0, 12)}${ext}`);
    await fs.copyFile(item.sourcePath, outputPath);
    accepted.push({ imageId: item.id, sourceUrl: item.sourceUrl, sourcePath: item.sourcePath,
      cleanPath: outputPath, sortOrder: accepted.length });
  }
  const invalidCount = evaluated.filter((item) => item.reasons.some((reason) =>
    ['watermark', 'chinese_text', 'collage', 'first_image_not_front_single'].includes(reason))).length;
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
