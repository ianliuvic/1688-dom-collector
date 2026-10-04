/**
 * Perceptual image hashing (dHash + pHash) for main-image duplicate checks.
 *
 * Both hashes are 64-bit values rendered as 16-char lowercase hex strings.
 * The same image content produces the same pair after re-encoding or CDN
 * resizing, so an "exact match" is an identical dHash AND pHash pair against
 * a different offer.
 */
import sharp from 'sharp';

const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;
const PHASH_SIZE = 32;
const PHASH_LOW = 8;
const HEX_PATTERN = /^[0-9a-f]{16}$/;

function phashScale(k) {
  return k === 0 ? Math.sqrt(1 / PHASH_SIZE) : Math.sqrt(2 / PHASH_SIZE);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function greyscaleRaw(buffer, width, height) {
  return sharp(buffer, { failOn: 'none' })
    .greyscale()
    .resize(width, height, { fit: 'fill' })
    .raw()
    .toBuffer();
}

export function isPerceptualHashHex(value) {
  return HEX_PATTERN.test(String(value || '').trim().toLowerCase());
}

export async function computeDhashHex(buffer) {
  const raw = await greyscaleRaw(buffer, DHASH_WIDTH, DHASH_HEIGHT);
  let hash = 0n;
  for (let y = 0; y < DHASH_HEIGHT; y += 1) {
    for (let x = 0; x < DHASH_WIDTH - 1; x += 1) {
      const left = raw[y * DHASH_WIDTH + x];
      const right = raw[y * DHASH_WIDTH + x + 1];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(16, '0');
}

export async function computePhashHex(buffer) {
  const raw = await greyscaleRaw(buffer, PHASH_SIZE, PHASH_SIZE);
  const cosine = [];
  for (let k = 0; k < PHASH_LOW; k += 1) {
    const row = new Float64Array(PHASH_SIZE);
    for (let n = 0; n < PHASH_SIZE; n += 1) {
      row[n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * PHASH_SIZE));
    }
    cosine.push(row);
  }

  const rowCoefficients = [];
  for (let y = 0; y < PHASH_SIZE; y += 1) {
    const row = new Float64Array(PHASH_LOW);
    for (let k = 0; k < PHASH_LOW; k += 1) {
      let sum = 0;
      for (let x = 0; x < PHASH_SIZE; x += 1) {
        sum += (raw[y * PHASH_SIZE + x] - 128) * cosine[k][x];
      }
      row[k] = sum * phashScale(k);
    }
    rowCoefficients.push(row);
  }

  const values = [];
  for (let ky = 0; ky < PHASH_LOW; ky += 1) {
    for (let kx = 0; kx < PHASH_LOW; kx += 1) {
      let sum = 0;
      for (let y = 0; y < PHASH_SIZE; y += 1) {
        sum += rowCoefficients[y][kx] * cosine[ky][y];
      }
      values.push(sum * phashScale(ky));
    }
  }

  const threshold = median(values);
  let hash = 0n;
  for (const value of values) {
    hash = (hash << 1n) | (value > threshold ? 1n : 0n);
  }
  return hash.toString(16).padStart(16, '0');
}

export async function computeImageHashes(buffer) {
  if (!buffer?.length) throw new Error('computeImageHashes requires a non-empty image buffer.');
  return {
    dhashHex: await computeDhashHex(buffer),
    phashHex: await computePhashHex(buffer),
  };
}
