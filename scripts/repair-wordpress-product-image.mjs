import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const postId = Number(process.env.WP_POST_ID);
const imageIndex = Math.max(0, Number(process.env.WP_IMAGE_INDEX) || 0);
const databaseUrl = process.env.DATABASE_URL;
const wpBaseUrl = String(process.env.WORDPRESS_BASE_URL || '').replace(/\/$/, '');
const wpUsername = process.env.WORDPRESS_USERNAME;
const wpPassword = process.env.WORDPRESS_APPLICATION_PASSWORD;

if (!postId || !databaseUrl || !wpBaseUrl || !wpUsername || !wpPassword) {
  throw new Error('WP_POST_ID and the collector database/WordPress environment are required.');
}

const authorization = `Basic ${Buffer.from(`${wpUsername}:${wpPassword}`).toString('base64')}`;
const pool = new Pool({ connectionString: databaseUrl, max: 2 });

async function wp(endpoint, options = {}) {
  const response = await fetch(`${wpBaseUrl}${endpoint}`, {
    ...options,
    headers: { authorization, accept: 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(body.message || `WordPress request failed (${response.status}).`);
  return body;
}

try {
  const publicationResult = await pool.query(
    'SELECT * FROM product_wordpress_publications WHERE wp_post_id=$1', [postId],
  );
  const publication = publicationResult.rows[0];
  if (!publication) throw new Error('No collector-managed WordPress publication matches this post.');

  const oldImage = publication.payload?.images?.[imageIndex];
  if (!oldImage) throw new Error('The requested published image index does not exist.');

  let imageResult = null;
  if (oldImage.source_image_id) {
    imageResult = await pool.query(
      'SELECT * FROM product_detail_images WHERE product_detail_id=$1 AND id=$2',
      [publication.product_detail_id, oldImage.source_image_id],
    );
  }
  if (!imageResult?.rows?.length) {
    imageResult = await pool.query(`
      SELECT * FROM product_detail_images
      WHERE product_detail_id=$1 AND image_type IN ('main','gallery')
      ORDER BY CASE WHEN image_type='main' THEN 0 ELSE 1 END, sort_order, id
      OFFSET $2 LIMIT 1
    `, [publication.product_detail_id, imageIndex]);
  }
  const sourceImage = imageResult.rows[0];
  if (!sourceImage?.storage_path) throw new Error('The source image has no persistent-storage file.');

  const binary = await fs.readFile(sourceImage.storage_path);
  if (binary.length < 1024) throw new Error('The persistent source image is unexpectedly small.');
  const extension = String(sourceImage.mime_type || '').includes('webp') ? 'webp' : 'jpg';
  const sourceHash = crypto.createHash('sha256').update(binary).digest('hex').slice(0, 16);
  const uploaded = await wp('/wp-json/hx/v1/products/media/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      external_id: publication.external_id,
      source_key: `${publication.external_id}:image-repair:${imageIndex}:${sourceHash}`,
      local_url: sourceImage.source_url,
      filename: `${publication.style_no}-${imageIndex + 1}-repaired.${extension}`,
      mime_type: sourceImage.mime_type || 'image/jpeg',
      alt: oldImage.alt || publication.payload.title,
      base64: binary.toString('base64'),
    }),
  });

  const images = publication.payload.images.map((image, index) => (index === imageIndex ? {
    ...image,
    attachment_id: Number(uploaded.attachment_id || uploaded.id),
    url: uploaded.url,
  } : image));
  const payload = { ...publication.payload, images };
  const synced = await wp('/wp-json/hx/v1/products/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  await pool.query(`
    UPDATE product_wordpress_publications
    SET payload=$2::jsonb, result=$3::jsonb, wp_url=$4, wp_status=$5,
      last_synced_at=now(), updated_at=now(), last_error=NULL
    WHERE id=$1
  `, [publication.id, JSON.stringify(payload), JSON.stringify(synced),
    synced.permalink || publication.wp_url, synced.status || publication.wp_status]);

  console.log(JSON.stringify({
    ok: true,
    postId,
    imageIndex,
    oldAttachmentId: Number(oldImage.attachment_id || 0),
    newAttachmentId: Number(uploaded.attachment_id || uploaded.id),
    newUrl: uploaded.url,
    bytes: binary.length,
  }));
} finally {
  await pool.end();
}
