// Publishing-time image deduplication.
//
// Exact duplicates are detected by content hash; near duplicates by dHash/pHash
// Hamming distance; and (optionally) a vision model reviews the survivors for
// visually redundant images that hashes cannot catch (slight crops, re-shots).
// Nothing on disk is deleted — the result only filters what gets published.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import sharp from 'sharp';

import { computeImageHashes } from './image-hash.js';
import { applyReasoning } from './model-request.js';

const FALLBACK_BASE_URL = 'https://api.deepseek.com';
const DHASH_MAX = 3;
const PHASH_MAX = 6;
const COLOR_TOLERANCE = 14;
const LLM_IMAGE_LIMIT = 16;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 4x4 RGB grid (48 bytes) — cheap colour fingerprint for near-dup checks. */
async function colorSignature(buffer) {
  try {
    const { data } = await sharp(buffer, { failOn: 'none' })
      .resize(4, 4, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return [...data];
  } catch {
    return null;
  }
}

function colorDistance(left, right) {
  if (!left || !right || left.length !== right.length) return 255;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]);
  return sum / left.length;
}

function nearDuplicateDistances(left, right) {
  const dh = hammingHex(left.dhashHex, right.dhashHex);
  const ph = hammingHex(left.phashHex, right.phashHex);
  if (dh <= DHASH_MAX && ph <= PHASH_MAX) return { dh, ph, colour: null };
  const colour = colorDistance(left.color, right.color);
  // Identical structure with matching colours = the same photo re-cropped or
  // re-encoded; different colours of the same pose stay untouched.
  if (ph <= 4 && colour <= COLOR_TOLERANCE) return { dh, ph, colour };
  if (ph <= 3 && dh <= 8 && colour <= COLOR_TOLERANCE) return { dh, ph, colour };
  return null;
}

export function hammingHex(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!a || a.length !== b.length) return 64;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = parseInt(a[index], 16) ^ parseInt(b[index], 16);
    distance += ((x >> 3) & 1) + ((x >> 2) & 1) + ((x >> 1) & 1) + (x & 1);
  }
  return distance;
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

/** Exact (sha) + near (dHash/pHash) dedupe. Keeps the earliest entry. */
export async function dedupeImagesByHash(images) {
  const kept = [];
  const removed = [];
  const bySha = new Map();
  const withHashes = [];
  for (const image of images) {
    let sha = image.contentSha256 || null;
    let hash = null;
    if (image.storagePath) {
      try {
        const bytes = await fs.readFile(image.storagePath);
        if (!sha) sha = sha256(bytes);
        hash = { ...await computeImageHashes(bytes), color: await colorSignature(bytes) };
      } catch { /* keep going without hashes */ }
    }
    if (sha && bySha.has(sha)) {
      removed.push({ imageId: String(image.id), keptImageId: String(bySha.get(sha).id), reason: 'exact' });
      continue;
    }
    let near = null;
    if (hash) {
      for (const entry of withHashes) {
        const match = nearDuplicateDistances(entry.hash, hash);
        if (match) {
          near = { entry, ...match };
          break;
        }
      }
    }
    if (near) {
      removed.push({
        imageId: String(image.id), keptImageId: String(near.entry.image.id), reason: 'near',
        dhashDistance: near.dh, phashDistance: near.ph, colorDistance: near.colour,
      });
      continue;
    }
    if (sha) bySha.set(sha, image);
    if (hash) withHashes.push({ image, hash });
    kept.push(image);
  }
  return { kept, removed };
}

/** Vision review of the hash-deduped survivors: which numbered images repeat. */
export async function dedupeImagesWithLlm({ images, title = '', config = {} }) {
  const candidates = images.slice(0, LLM_IMAGE_LIMIT).filter((image) => image.url);
  if (candidates.length < 2) return { removed: [], model: config.model ?? null, skipped: true };
  const numbered = candidates.map((image, index) => ({ ...image, number: index + 1 }));
  const prompt = `你是商品图片审核助手，只输出严格JSON。
下面的图片属于同一个商品（按编号顺序提供）。找出其中"与其他图片重复或几乎相同"的图片：
- 同一张图的不同裁剪/压缩、轻微角度或距离差异、同一画面不同拼接，都算重复；
- 只保留一张最有代表性的（编号最小的那张），其余列出应删除的编号；
- 不确定时不要算作重复。
输出格式：{"duplicates":[{"number":4,"same_as":2,"reason":"同一张图的裁剪版"}]}
标题：${JSON.stringify(String(title || '').slice(0, 100))}`;
  const content = [
    { type: 'text', text: prompt },
    ...numbered.map((image) => ({ type: 'image_url', image_url: { url: image.url } })),
  ];
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
    throw new Error(`Image dedupe model failed (${response.status}): ${String(detail).slice(0, 160)}`);
  }
  const payload = await response.json();
  const text = contentText(payload.choices?.[0]?.message?.content);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch { parsed = null; } }
  }
  const removed = [];
  for (const entry of Array.isArray(parsed?.duplicates) ? parsed.duplicates : []) {
    const number = Number(entry?.number);
    const sameAs = Number(entry?.same_as);
    if (!Number.isInteger(number) || number < 1 || number > numbered.length) continue;
    if (Number.isInteger(sameAs) && sameAs >= 1 && sameAs < number) {
      removed.push({
        imageId: String(numbered[number - 1].id), keptImageId: String(numbered[sameAs - 1].id),
        reason: 'llm', note: String(entry?.reason || '').slice(0, 120),
      });
    } else {
      removed.push({ imageId: String(numbered[number - 1].id), keptImageId: null, reason: 'llm', note: String(entry?.reason || '').slice(0, 120) });
    }
  }
  return { removed, model: config.model ?? null, considered: numbered.length };
}
