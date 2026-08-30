import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_PROMPT = '请分析这张1688商品主图。仅返回JSON，字段包括：product_type（产品类型）、color（主要颜色）、design_details（可见设计细节数组）、material_cues（可见材质线索数组）、pattern（图案）、quality_notes（做工/品质可见特征数组）、confidence（0到1的小数）。不要编造图片中不可见的信息。';

function endpointFrom(baseUrl) {
  const base = String(baseUrl || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  if (base.includes('/compatible-mode')) return `${base}/v1/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function parseContent(content) {
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

function parseJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { return null; }
}

export async function analyzeProductImage({ imagePath, sourceUrl = null, offerId = null, prompt = DEFAULT_PROMPT, config = {} }) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured.');
  const resolved = path.resolve(imagePath);
  const storageRoot = path.resolve(config.storagePath || '/app/storage');
  if (!resolved.startsWith(`${storageRoot}${path.sep}`)) throw new Error('Image path is outside persistent storage.');
  const buffer = await fs.readFile(resolved);
  if (buffer.length > 15 * 1024 * 1024) throw new Error('Image exceeds the 15 MB analysis limit.');
  const ext = path.extname(resolved).toLowerCase();
  const mimeType = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' })[ext] || 'application/octet-stream';
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const response = await fetch(endpointFrom(config.baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model || 'deepseek-v4-flash-vision-exp',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.text();
  let payload;
  try { payload = JSON.parse(body); } catch { payload = { raw: body.slice(0, 2000) }; }
  if (!response.ok) throw new Error(`DeepSeek vision request failed (${response.status}).`);
  const content = parseContent(payload.choices?.[0]?.message?.content);
  return { model: config.model || 'deepseek-v4-flash-vision-exp', sourceUrl, offerId, imagePath: resolved, prompt, content, parsed: parseJson(content), usage: payload.usage ?? null };
}
