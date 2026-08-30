import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import { deriveVerifiedProductPrice } from './parsers/1688-product.js';

const { Pool } = pg;

export function createDatabase(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  async function migrate() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS capture_jobs (
        id uuid PRIMARY KEY,
        url text NOT NULL,
        status text NOT NULL DEFAULT 'queued',
        title text,
        final_url text,
        dom_path text,
        screenshot_path text,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        completed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS capture_jobs_status_created_idx
        ON capture_jobs (status, created_at);
      ALTER TABLE capture_jobs
        ADD COLUMN IF NOT EXISTS extracted_data jsonb;
      ALTER TABLE capture_jobs
        ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'::jsonb;
      CREATE TABLE IF NOT EXISTS shop_profiles (
        id bigserial PRIMARY KEY,
        shop_url text NOT NULL UNIQUE,
        domain text NOT NULL,
        shop_name text,
        page_title text,
        member_id text,
        seller_id bigint,
        company_id text,
        seller_type text,
        main_category text,
        address text,
        established_year text,
        established_date date,
        follower_count integer,
        offer_count integer,
        service_score numeric(4,2),
        repeat_rate text,
        fulfillment_rate text,
        years_on_platform text,
        contact_name text,
        phone text,
        mobile text,
        fax text,
        wangwang_url text,
        offer_list_url text,
        new_offer_list_url text,
        navigation jsonb NOT NULL DEFAULT '[]'::jsonb,
        raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS shop_profiles_domain_idx ON shop_profiles (domain);
      CREATE INDEX IF NOT EXISTS shop_profiles_member_id_idx ON shop_profiles (member_id);
      CREATE INDEX IF NOT EXISTS shop_profiles_offer_count_idx ON shop_profiles (offer_count);
      ALTER TABLE shop_profiles ADD COLUMN IF NOT EXISTS contact_name text;
      ALTER TABLE shop_profiles ADD COLUMN IF NOT EXISTS wangwang_url text;
      CREATE TABLE IF NOT EXISTS shop_scan_runs (
        id bigserial PRIMARY KEY,
        job_id uuid NOT NULL UNIQUE REFERENCES capture_jobs(id) ON DELETE CASCADE,
        shop_id bigint NOT NULL REFERENCES shop_profiles(id) ON DELETE CASCADE,
        total_count integer,
        fetched_count integer NOT NULL DEFAULT 0,
        request_count integer,
        truncated boolean NOT NULL DEFAULT false,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS shop_products (
        id bigserial PRIMARY KEY,
        shop_id bigint NOT NULL REFERENCES shop_profiles(id) ON DELETE CASCADE,
        offer_id text NOT NULL,
        title text,
        category text,
        price numeric(12,2),
        currency text,
        image_url text,
        product_url text,
        sale_quantity numeric(14,2),
        sale_quantity_text text,
        listing_time timestamptz,
        shipping_info text,
        status text NOT NULL DEFAULT 'unknown',
        raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_crawled_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (shop_id, offer_id)
      );
      CREATE INDEX IF NOT EXISTS shop_products_shop_idx ON shop_products (shop_id);
      CREATE INDEX IF NOT EXISTS shop_products_offer_idx ON shop_products (offer_id);
      CREATE INDEX IF NOT EXISTS shop_products_listing_idx ON shop_products (listing_time);
      CREATE INDEX IF NOT EXISTS shop_products_sales_idx ON shop_products (sale_quantity);
      CREATE INDEX IF NOT EXISTS shop_products_status_idx ON shop_products (status);
      CREATE TABLE IF NOT EXISTS shop_product_snapshots (
        id bigserial PRIMARY KEY,
        scan_run_id bigint NOT NULL REFERENCES shop_scan_runs(id) ON DELETE CASCADE,
        shop_product_id bigint NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
        title text,
        price numeric(12,2),
        sale_quantity numeric(14,2),
        sale_quantity_text text,
        listing_time timestamptz,
        status text,
        observed_at timestamptz NOT NULL DEFAULT now(),
        raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (scan_run_id, shop_product_id)
      );
      CREATE INDEX IF NOT EXISTS shop_product_snapshots_observed_idx
        ON shop_product_snapshots (observed_at);
      CREATE TABLE IF NOT EXISTS product_details (
        id bigserial PRIMARY KEY,
        offer_id text UNIQUE,
        source_url text NOT NULL UNIQUE,
        canonical_url text,
        title text,
        description text,
        currency text,
        price_min numeric(12,2),
        price_max numeric(12,2),
        moq integer,
        seller_name text,
        seller_url text,
        raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_crawled_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS product_details_title_idx ON product_details (title);
      CREATE INDEX IF NOT EXISTS product_details_last_crawled_idx ON product_details (last_crawled_at);
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS gallery_content_fingerprint text;
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS gallery_image_count integer NOT NULL DEFAULT 0;
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS gallery_verified_complete boolean NOT NULL DEFAULT false;
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS duplicate_status text NOT NULL DEFAULT 'not_checked';
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS duplicate_analysis jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS duplicate_checked_at timestamptz;
      CREATE INDEX IF NOT EXISTS product_details_gallery_fingerprint_idx
        ON product_details (gallery_content_fingerprint)
        WHERE gallery_content_fingerprint IS NOT NULL;
      CREATE INDEX IF NOT EXISTS product_details_duplicate_status_idx
        ON product_details (duplicate_status);
      CREATE TABLE IF NOT EXISTS product_detail_images (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        image_type text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        source_url text NOT NULL,
        storage_path text,
        mime_type text,
        downloaded_at timestamptz,
        UNIQUE (product_detail_id, image_type, sort_order, source_url)
      );
      CREATE INDEX IF NOT EXISTS product_detail_images_product_idx ON product_detail_images (product_detail_id);
      ALTER TABLE product_detail_images ADD COLUMN IF NOT EXISTS content_sha256 text;
      ALTER TABLE product_detail_images ADD COLUMN IF NOT EXISTS byte_size bigint;
      CREATE INDEX IF NOT EXISTS product_detail_images_content_sha_idx
        ON product_detail_images (content_sha256)
        WHERE content_sha256 IS NOT NULL;
      CREATE TABLE IF NOT EXISTS product_detail_skus (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        sku_key text NOT NULL,
        sku_text text,
        price numeric(12,2),
        stock numeric(14,2),
        image_source_url text,
        image_storage_path text,
        option_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (product_detail_id, sku_key)
      );
      CREATE TABLE IF NOT EXISTS product_detail_attributes (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        name text NOT NULL,
        value text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        UNIQUE (product_detail_id, name, value)
      );
      CREATE TABLE IF NOT EXISTS product_detail_price_tiers (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        min_quantity numeric(14,2),
        max_quantity numeric(14,2),
        price numeric(12,2) NOT NULL,
        currency text,
        UNIQUE (product_detail_id, min_quantity, max_quantity, price)
      );
      CREATE TABLE IF NOT EXISTS product_vision_analyses (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        image_id bigint REFERENCES product_detail_images(id) ON DELETE SET NULL,
        model text NOT NULL,
        image_path text NOT NULL,
        source_url text,
        prompt text,
        content text,
        parsed jsonb,
        usage jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS product_vision_analyses_product_idx ON product_vision_analyses(product_detail_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS product_image_cleanups (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        model text NOT NULL,
        status text NOT NULL,
        gallery_count integer NOT NULL DEFAULT 0,
        accepted_count integer NOT NULL DEFAULT 0,
        first_image_passed boolean NOT NULL DEFAULT false,
        back_image_warning boolean NOT NULL DEFAULT false,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS product_image_cleanups_product_idx ON product_image_cleanups(product_detail_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS product_image_audits (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        trigger_type text NOT NULL DEFAULT 'manual',
        model text NOT NULL,
        schema_version integer,
        source_hash text,
        status text NOT NULL DEFAULT 'queued',
        audit_status text,
        summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        completed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS product_image_audits_product_idx
        ON product_image_audits(product_detail_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS product_sku_audits (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        trigger_type text NOT NULL DEFAULT 'manual',
        model text NOT NULL,
        schema_version integer,
        source_hash text,
        status text NOT NULL DEFAULT 'queued',
        audit_status text,
        summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        completed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS product_sku_audits_product_idx
        ON product_sku_audits(product_detail_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS product_detail_translations (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        source_language text NOT NULL DEFAULT 'zh-CN',
        target_language text NOT NULL,
        model text NOT NULL,
        source_hash text NOT NULL,
        title text,
        description text,
        seller_name text,
        attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
        sku_dimensions jsonb NOT NULL DEFAULT '[]'::jsonb,
        sku_options jsonb NOT NULL DEFAULT '[]'::jsonb,
        sku_rows jsonb NOT NULL DEFAULT '[]'::jsonb,
        price_text_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
        source_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        translated_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        image_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
        image_count integer NOT NULL DEFAULT 0,
        naming_strategy text NOT NULL DEFAULT 'visual_rewrite',
        usage jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (product_detail_id, target_language, source_hash, model)
      );
      CREATE INDEX IF NOT EXISTS product_detail_translations_product_idx
        ON product_detail_translations(product_detail_id, target_language, created_at DESC);
      ALTER TABLE product_detail_translations
        ADD COLUMN IF NOT EXISTS image_sources jsonb NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE product_detail_translations
        ADD COLUMN IF NOT EXISTS image_count integer NOT NULL DEFAULT 0;
      ALTER TABLE product_detail_translations
        ADD COLUMN IF NOT EXISTS naming_strategy text NOT NULL DEFAULT 'visual_rewrite';
      CREATE TABLE IF NOT EXISTS product_wordpress_publications (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL UNIQUE REFERENCES product_details(id) ON DELETE CASCADE,
        translation_id bigint REFERENCES product_detail_translations(id) ON DELETE SET NULL,
        external_id text NOT NULL,
        style_no text,
        wp_post_id bigint,
        wp_url text,
        wp_edit_url text,
        wp_status text,
        sync_hash text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        last_error text,
        first_published_at timestamptz,
        last_synced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS product_wordpress_publications_post_idx
        ON product_wordpress_publications(wp_post_id);
      CREATE INDEX IF NOT EXISTS product_wordpress_publications_external_idx
        ON product_wordpress_publications(external_id);
      CREATE TABLE IF NOT EXISTS product_rag_syncs (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        trigger_type text NOT NULL,
        status text NOT NULL DEFAULT 'queued',
        canonical_product_id text,
        active boolean NOT NULL DEFAULT false,
        attempt_count integer NOT NULL DEFAULT 0,
        request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
        error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        completed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS product_rag_syncs_product_idx
        ON product_rag_syncs(product_detail_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS product_rag_syncs_status_idx
        ON product_rag_syncs(status, created_at);
    `);
  }

  async function createJob(id, url, options = {}) {
    const result = await pool.query(
      'INSERT INTO capture_jobs (id, url, options) VALUES ($1, $2, $3) RETURNING *',
      [id, url, options],
    );
    return result.rows[0];
  }

  async function getJob(id) {
    const result = await pool.query('SELECT * FROM capture_jobs WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function claimNextJob() {
    const result = await pool.query(`
      UPDATE capture_jobs
      SET status = 'running', started_at = now(), error = NULL
      WHERE id = (
        SELECT id FROM capture_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `);
    return result.rows[0] ?? null;
  }

  async function completeJob(id, values) {
    await pool.query(
      `UPDATE capture_jobs
       SET status = $2, title = $3, final_url = $4, dom_path = $5,
           screenshot_path = $6, error = $7, extracted_data = $8, completed_at = now()
       WHERE id = $1`,
      [id, values.status, values.title, values.finalUrl, values.domPath,
        values.screenshotPath, values.error, values.extractedData ?? null],
    );
  }

  async function upsertShopProfile(data) {
    if (!data || data.pageType !== 'shop' || !data.url) return null;
    const parsedUrl = new URL(data.url);
    const shopUrl = `${parsedUrl.origin}/`;
    const company = data.company ?? {};
    const metrics = data.metrics ?? {};
    const contact = data.contact ?? {};
    const offerListUrl = data.offerListUrl
      ?? data.navigation?.find((item) => item.id === 'offerlist')?.url ?? null;
    const newOfferListUrl = data.newOfferListUrl
      ?? data.navigation?.find((item) => item.id === 'newofferlist')?.url ?? null;
    const result = await pool.query(`
      INSERT INTO shop_profiles (
        shop_url, domain, shop_name, page_title, member_id, seller_id, company_id,
        seller_type, main_category, address, established_year, established_date,
        follower_count, offer_count, service_score, repeat_rate, fulfillment_rate,
        years_on_platform, contact_name, phone, mobile, fax, wangwang_url, offer_list_url, new_offer_list_url,
        navigation, raw_data, last_seen_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,now())
      ON CONFLICT (shop_url) DO UPDATE SET
        domain=EXCLUDED.domain, shop_name=EXCLUDED.shop_name, page_title=EXCLUDED.page_title,
        member_id=EXCLUDED.member_id, seller_id=EXCLUDED.seller_id, company_id=EXCLUDED.company_id,
        seller_type=EXCLUDED.seller_type, main_category=EXCLUDED.main_category,
        address=EXCLUDED.address, established_year=EXCLUDED.established_year,
        established_date=EXCLUDED.established_date, follower_count=EXCLUDED.follower_count,
        offer_count=EXCLUDED.offer_count, service_score=EXCLUDED.service_score,
        repeat_rate=EXCLUDED.repeat_rate, fulfillment_rate=EXCLUDED.fulfillment_rate,
        years_on_platform=EXCLUDED.years_on_platform, contact_name=EXCLUDED.contact_name,
        phone=EXCLUDED.phone, mobile=EXCLUDED.mobile, fax=EXCLUDED.fax,
        wangwang_url=EXCLUDED.wangwang_url, offer_list_url=EXCLUDED.offer_list_url,
        new_offer_list_url=EXCLUDED.new_offer_list_url, navigation=EXCLUDED.navigation,
        raw_data=EXCLUDED.raw_data, last_seen_at=now()
      RETURNING *
    `, [
      shopUrl, parsedUrl.hostname, company.name ?? null, data.title ?? null,
      company.memberId ?? null, company.sellerId ?? null, company.companyId ?? null,
      company.sellerType ?? null, company.mainCategory ?? null, company.address ?? null,
      company.establishedYear ?? null, parseDate(company.establishedDate),
      metrics.followerCount ?? null, metrics.offerCount ?? null,
      parseScore(metrics.serviceScore), metrics.repeatRate ?? null,
      metrics.fulfillmentRate ?? null, metrics.yearsOnPlatform ?? null,
      contact.name ?? null, contact.phone ?? null, contact.mobile ?? null, contact.fax ?? null,
      data.wangwangUrl ?? null, offerListUrl, newOfferListUrl,
      JSON.stringify(data.navigation ?? []), JSON.stringify(data),
    ]);
    return result.rows[0];
  }

  async function listShopProfiles(limit = 100) {
    const result = await pool.query(
      'SELECT * FROM shop_profiles ORDER BY last_seen_at DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 100, 1), 500)],
    );
    return result.rows;
  }

  async function saveShopScan(jobId, data) {
    if (!data || data.pageType !== 'shop-offer-collection' || !data.shop) return null;
    const shop = await upsertShopProfile(data.shop);
    const run = await pool.query(`
      INSERT INTO shop_scan_runs (job_id, shop_id, total_count, fetched_count, request_count, truncated)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (job_id) DO UPDATE SET
        total_count=EXCLUDED.total_count, fetched_count=EXCLUDED.fetched_count,
        request_count=EXCLUDED.request_count, truncated=EXCLUDED.truncated,
        completed_at=now()
      RETURNING *
    `, [jobId, shop.id, data.totalCount ?? null, data.offerCount ?? 0,
      data.requestCount ?? null, data.truncated === true]);
    const scanRun = run.rows[0];
    let saved = 0;
    for (const offer of data.offers ?? []) {
      const offerId = offer?.offerId == null ? null : String(offer.offerId);
      if (!offerId) continue;
      const product = normalizeOffer(offer);
      const productResult = await pool.query(`
        INSERT INTO shop_products (
          shop_id, offer_id, title, category, price, currency, image_url, product_url,
          sale_quantity, sale_quantity_text, listing_time, shipping_info, status, raw_data, last_crawled_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
        ON CONFLICT (shop_id, offer_id) DO UPDATE SET
          title=EXCLUDED.title, category=EXCLUDED.category, price=EXCLUDED.price,
          currency=EXCLUDED.currency, image_url=EXCLUDED.image_url, product_url=EXCLUDED.product_url,
          sale_quantity=EXCLUDED.sale_quantity, sale_quantity_text=EXCLUDED.sale_quantity_text,
          listing_time=COALESCE(EXCLUDED.listing_time, shop_products.listing_time),
          shipping_info=EXCLUDED.shipping_info, status=EXCLUDED.status, raw_data=EXCLUDED.raw_data,
          last_crawled_at=now()
        RETURNING id
      `, [shop.id, offerId, product.title, product.category, product.price, product.currency,
        product.imageUrl, product.productUrl, product.saleQuantity, product.saleQuantityText,
        product.listingTime, product.shippingInfo, product.status, JSON.stringify(offer)]);
      await pool.query(`
        INSERT INTO shop_product_snapshots
          (scan_run_id, shop_product_id, title, price, sale_quantity, sale_quantity_text, listing_time, status, raw_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (scan_run_id, shop_product_id) DO NOTHING
      `, [scanRun.id, productResult.rows[0].id, product.title, product.price,
        product.saleQuantity, product.saleQuantityText, product.listingTime,
        product.status, JSON.stringify(offer)]);
      saved += 1;
    }
    return { shopId: shop.id, scanRunId: scanRun.id, savedProducts: saved };
  }

  async function listShopProducts(shopId, limit = 100) {
    const result = await pool.query(
      'SELECT * FROM shop_products WHERE shop_id = $1 ORDER BY last_crawled_at DESC LIMIT $2',
      [shopId, Math.min(Math.max(Number(limit) || 100, 1), 1000)],
    );
    return result.rows;
  }

  async function saveProductDetail(data, sourceUrl, imageFiles = [], duplicateAnalysis = null) {
    if (!data || data.pageType !== 'product' || !sourceUrl) return null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = data.offerId
        ? await client.query('SELECT id FROM product_details WHERE offer_id = $1 OR source_url = $2 LIMIT 1', [String(data.offerId), sourceUrl])
        : await client.query('SELECT id FROM product_details WHERE source_url = $1 LIMIT 1', [sourceUrl]);
      const price = data.price ?? {};
      const galleryProfile = duplicateAnalysis?.galleryProfile ?? {};
      let detailId;
      if (existing.rows[0]) {
        detailId = existing.rows[0].id;
        await client.query(`UPDATE product_details SET offer_id=$1, source_url=$2, canonical_url=$3,
          title=$4, description=$5, currency=$6, price_min=$7, price_max=$8, moq=$9,
          seller_name=$10, seller_url=$11, raw_data=$12,
          gallery_content_fingerprint=$13, gallery_image_count=$14,
          gallery_verified_complete=$15, duplicate_status=$16, duplicate_analysis=$17,
          duplicate_checked_at=$18, last_crawled_at=now() WHERE id=$19`, [
          data.offerId ? String(data.offerId) : null, sourceUrl, data.canonicalUrl ?? null,
          data.title ?? null, data.description ?? null, data.currency ?? null,
          price.min ?? null, price.max ?? null, data.moq ?? null,
          data.seller?.name ?? null, data.seller?.url ?? null, JSON.stringify(data),
          galleryProfile.fingerprint ?? null, galleryProfile.sourceImageCount ?? 0,
          Boolean(galleryProfile.verifiedComplete), duplicateAnalysis?.status ?? 'not_checked',
          JSON.stringify(duplicateAnalysis ?? {}), duplicateAnalysis?.checkedAt ?? null, detailId,
        ]);
        await client.query('DELETE FROM product_detail_images WHERE product_detail_id=$1', [detailId]);
        await client.query('DELETE FROM product_detail_skus WHERE product_detail_id=$1', [detailId]);
        await client.query('DELETE FROM product_detail_attributes WHERE product_detail_id=$1', [detailId]);
        await client.query('DELETE FROM product_detail_price_tiers WHERE product_detail_id=$1', [detailId]);
      } else {
        const inserted = await client.query(`INSERT INTO product_details
          (offer_id, source_url, canonical_url, title, description, currency, price_min, price_max,
           moq, seller_name, seller_url, raw_data, gallery_content_fingerprint,
           gallery_image_count, gallery_verified_complete, duplicate_status,
           duplicate_analysis, duplicate_checked_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`, [
          data.offerId ? String(data.offerId) : null, sourceUrl, data.canonicalUrl ?? null,
          data.title ?? null, data.description ?? null, data.currency ?? null,
          price.min ?? null, price.max ?? null, data.moq ?? null,
          data.seller?.name ?? null, data.seller?.url ?? null, JSON.stringify(data),
          galleryProfile.fingerprint ?? null, galleryProfile.sourceImageCount ?? 0,
          Boolean(galleryProfile.verifiedComplete), duplicateAnalysis?.status ?? 'not_checked',
          JSON.stringify(duplicateAnalysis ?? {}), duplicateAnalysis?.checkedAt ?? null,
        ]);
        detailId = inserted.rows[0].id;
      }
      for (const image of imageFiles) {
        await client.query(`INSERT INTO product_detail_images
          (product_detail_id, image_type, sort_order, source_url, storage_path, mime_type,
           downloaded_at, content_sha256, byte_size)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [detailId, image.type, image.sortOrder ?? 0,
          image.sourceUrl, image.storagePath ?? null, image.mimeType ?? null,
          image.storagePath ? new Date() : null, image.contentSha256 ?? null,
          image.byteSize ?? null]);
      }
      for (const [index, sku] of (data.skuRows ?? []).entries()) {
        await client.query(`INSERT INTO product_detail_skus
          (product_detail_id, sku_key, sku_text, price, stock, option_data, raw_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [detailId, String(sku.skuKey ?? sku.skuText ?? index),
          sku.skuText ?? sku.text ?? null, sku.price ?? null, sku.stock ?? null,
          JSON.stringify(sku.options ?? {}), JSON.stringify(sku)]);
      }
      for (const [index, attribute] of (data.attributes ?? []).entries()) {
        await client.query(`INSERT INTO product_detail_attributes
          (product_detail_id, name, value, sort_order) VALUES ($1,$2,$3,$4)`,
        [detailId, String(attribute.name), String(attribute.value), index]);
      }
      for (const tier of price.tiers ?? []) {
        await client.query(`INSERT INTO product_detail_price_tiers
          (product_detail_id, min_quantity, max_quantity, price, currency)
          VALUES ($1,$2,$3,$4,$5)`, [detailId, tier.minQuantity ?? null, tier.maxQuantity ?? null,
          tier.price, data.currency ?? null]);
      }
      await client.query('COMMIT');
      return { productDetailId: detailId, imageCount: imageFiles.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getProductDetail(id) {
    const detail = await pool.query(`SELECT product_details.*,
      COALESCE(
        (SELECT shop_products.listing_time FROM shop_products
          WHERE shop_products.offer_id = product_details.offer_id
            AND shop_products.listing_time IS NOT NULL
          ORDER BY shop_products.last_crawled_at DESC LIMIT 1),
        product_details.first_seen_at
      ) AS publication_date,
      CASE WHEN EXISTS (
        SELECT 1 FROM shop_products
        WHERE shop_products.offer_id = product_details.offer_id
          AND shop_products.listing_time IS NOT NULL
      ) THEN '1688_listing_time' ELSE 'first_seen_at' END AS publication_date_source
      FROM product_details WHERE product_details.id = $1`, [id]);
    if (!detail.rows[0]) return null;
    const [images, skus, attributes, tiers, imageAudit, skuAudit] = await Promise.all([
      pool.query('SELECT * FROM product_detail_images WHERE product_detail_id = $1 ORDER BY image_type, sort_order', [id]),
      pool.query('SELECT * FROM product_detail_skus WHERE product_detail_id = $1 ORDER BY id', [id]),
      pool.query('SELECT * FROM product_detail_attributes WHERE product_detail_id = $1 ORDER BY sort_order', [id]),
      pool.query('SELECT * FROM product_detail_price_tiers WHERE product_detail_id = $1 ORDER BY min_quantity NULLS FIRST', [id]),
      pool.query('SELECT * FROM product_image_audits WHERE product_detail_id=$1 ORDER BY created_at DESC LIMIT 1', [id]),
      pool.query('SELECT * FROM product_sku_audits WHERE product_detail_id=$1 ORDER BY created_at DESC LIMIT 1', [id]),
    ]);
    return { ...detail.rows[0], images: images.rows, skus: skus.rows,
      attributes: attributes.rows, priceTiers: tiers.rows,
      latestImageAudit: imageAudit.rows[0] ?? null, latestSkuAudit: skuAudit.rows[0] ?? null };
  }

  async function listProductDetails({ offerId = null, limit = 100 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    if (offerId) {
      const result = await pool.query(`SELECT * FROM product_details
        WHERE offer_id=$1 ORDER BY last_crawled_at DESC LIMIT $2`, [String(offerId), safeLimit]);
      return result.rows;
    }
    const result = await pool.query(`SELECT * FROM product_details
      ORDER BY last_crawled_at DESC LIMIT $1`, [safeLimit]);
    return result.rows;
  }

  async function findExactGalleryDuplicates({ offerId, fingerprint, imageCount }) {
    if (!fingerprint || Number(imageCount) < 2) return [];
    const result = await pool.query(`SELECT id AS product_detail_id, offer_id, source_url,
      canonical_url, title, gallery_content_fingerprint AS gallery_fingerprint,
      gallery_image_count, gallery_image_count AS matched_image_count
      FROM product_details
      WHERE gallery_content_fingerprint=$1
        AND gallery_verified_complete=true
        AND gallery_image_count=$2
        AND ($3::text IS NULL OR offer_id IS DISTINCT FROM $3::text)
      ORDER BY last_crawled_at DESC LIMIT 10`, [fingerprint, Number(imageCount), offerId ? String(offerId) : null]);
    return result.rows;
  }

  async function findGalleryHashCandidates({ offerId, contentHashes, currentImageCount, limit = 10 }) {
    const hashes = [...new Set((contentHashes ?? []).filter(Boolean))];
    if (!hashes.length) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const result = await pool.query(`SELECT details.id AS product_detail_id, details.offer_id,
      details.source_url, details.canonical_url, details.title, details.gallery_image_count,
      details.gallery_content_fingerprint AS gallery_fingerprint,
      count(DISTINCT images.content_sha256)::int AS matched_image_count,
      $2::int AS current_image_count
      FROM product_details details
      JOIN product_detail_images images ON images.product_detail_id=details.id
      WHERE images.image_type IN ('main','gallery')
        AND images.content_sha256=ANY($1::text[])
        AND ($3::text IS NULL OR details.offer_id IS DISTINCT FROM $3::text)
      GROUP BY details.id
      ORDER BY matched_image_count DESC, details.last_crawled_at DESC
      LIMIT $4`, [hashes, Number(currentImageCount) || 0, offerId ? String(offerId) : null, safeLimit]);
    return result.rows;
  }

  async function backfillProductImageHashes() {
    const missing = await pool.query(`SELECT id, storage_path FROM product_detail_images
      WHERE storage_path IS NOT NULL AND content_sha256 IS NULL ORDER BY id`);
    let hashed = 0;
    for (const image of missing.rows) {
      try {
        const bytes = await fs.readFile(image.storage_path);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        await pool.query(`UPDATE product_detail_images SET content_sha256=$2, byte_size=$3
          WHERE id=$1`, [image.id, digest, bytes.length]);
        hashed += 1;
      } catch { /* Missing legacy files remain unhashed and cannot cause a false exact match. */ }
    }

    const products = await pool.query(`SELECT details.id, details.raw_data,
      array_remove(array_agg(images.content_sha256 ORDER BY
        CASE WHEN images.image_type='main' THEN 0 ELSE 1 END,
        images.sort_order, images.id), NULL) AS hashes
      FROM product_details details
      LEFT JOIN product_detail_images images ON images.product_detail_id=details.id
        AND images.image_type IN ('main','gallery')
      GROUP BY details.id`);
    let fingerprinted = 0;
    for (const product of products.rows) {
      const raw = product.raw_data ?? {};
      const sourceUrls = [...new Set([raw.mainImage, ...(raw.images ?? [])].filter(Boolean))];
      const hashes = [...(product.hashes ?? [])].sort();
      const gallery = raw.gallery ?? {};
      const verified = gallery.source === 'exact_dom_gallery' && gallery.complete === true
        && gallery.stable === true && Number(gallery.unresolvedSlotCount || 0) === 0
        && sourceUrls.length > 0 && hashes.length === sourceUrls.length;
      const fingerprint = verified
        ? crypto.createHash('sha256').update(hashes.join('\n')).digest('hex') : null;
      await pool.query(`UPDATE product_details SET gallery_content_fingerprint=$2,
        gallery_image_count=$3, gallery_verified_complete=$4 WHERE id=$1`,
      [product.id, fingerprint, hashes.length, verified]);
      if (fingerprint) fingerprinted += 1;
    }
    return { hashed, fingerprinted, products: products.rowCount };
  }

  async function saveProductVision(productDetailId, imageId, result) {
    const saved = await pool.query(`INSERT INTO product_vision_analyses
      (product_detail_id, image_id, model, image_path, source_url, prompt, content, parsed, usage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [productDetailId, imageId ?? null,
      result.model, result.imagePath, result.sourceUrl, result.prompt, result.content,
      result.parsed ? JSON.stringify(result.parsed) : null, result.usage ? JSON.stringify(result.usage) : null]);
    return { visionAnalysisId: saved.rows[0].id, ...saved.rows[0] };
  }

  async function listProductVision(productDetailId) {
    const result = await pool.query('SELECT * FROM product_vision_analyses WHERE product_detail_id=$1 ORDER BY created_at DESC', [productDetailId]);
    return result.rows;
  }

  async function saveProductImageCleanup(productDetailId, result) {
    const saved = await pool.query(`INSERT INTO product_image_cleanups
      (product_detail_id, model, status, gallery_count, accepted_count, first_image_passed, back_image_warning, result)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [productDetailId, result.model, result.status,
      result.galleryCount, result.acceptedCount, result.firstImagePassed, result.backImageWarning, JSON.stringify(result)]);
    return saved.rows[0];
  }

  async function listProductImageCleanups(productDetailId) {
    const result = await pool.query('SELECT * FROM product_image_cleanups WHERE product_detail_id=$1 ORDER BY created_at DESC', [productDetailId]);
    return result.rows;
  }

  async function createProductAudit(auditType, productDetailId, values = {}) {
    const table = auditType === 'image' ? 'product_image_audits'
      : auditType === 'sku' ? 'product_sku_audits' : null;
    if (!table) throw new Error('Unsupported product audit type.');
    const saved = await pool.query(`INSERT INTO ${table}
      (product_detail_id, trigger_type, model, status)
      VALUES ($1,$2,$3,'queued') RETURNING *`, [productDetailId,
      values.trigger ?? 'manual', values.model ?? 'qwen3.8-max']);
    return saved.rows[0];
  }

  async function startProductAudit(auditType, id) {
    const table = auditType === 'image' ? 'product_image_audits'
      : auditType === 'sku' ? 'product_sku_audits' : null;
    if (!table) throw new Error('Unsupported product audit type.');
    const saved = await pool.query(`UPDATE ${table}
      SET status='running', started_at=now(), error=NULL WHERE id=$1 RETURNING *`, [id]);
    return saved.rows[0] ?? null;
  }

  async function completeProductAudit(auditType, id, result, sourceHash = null) {
    const table = auditType === 'image' ? 'product_image_audits'
      : auditType === 'sku' ? 'product_sku_audits' : null;
    if (!table) throw new Error('Unsupported product audit type.');
    const model = result?.models?.complex ?? result?.models?.vision ?? 'qwen3.8-max';
    const saved = await pool.query(`UPDATE ${table} SET status='completed', model=$2,
      schema_version=$3, source_hash=$4, audit_status=$5, summary=$6, result=$7,
      error=NULL, completed_at=now() WHERE id=$1 RETURNING *`, [id, model,
      result?.schemaVersion ?? null, sourceHash, result?.auditStatus ?? null,
      JSON.stringify(result?.summary ?? {}), JSON.stringify(result ?? {})]);
    return saved.rows[0] ?? null;
  }

  async function failProductAudit(auditType, id, error) {
    const table = auditType === 'image' ? 'product_image_audits'
      : auditType === 'sku' ? 'product_sku_audits' : null;
    if (!table) throw new Error('Unsupported product audit type.');
    const saved = await pool.query(`UPDATE ${table} SET status='failed', error=$2,
      completed_at=now() WHERE id=$1 RETURNING *`, [id, String(error?.message ?? error)]);
    return saved.rows[0] ?? null;
  }

  async function listProductAudits(auditType, productDetailId, limit = 20) {
    const table = auditType === 'image' ? 'product_image_audits'
      : auditType === 'sku' ? 'product_sku_audits' : null;
    if (!table) throw new Error('Unsupported product audit type.');
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const result = await pool.query(`SELECT * FROM ${table}
      WHERE product_detail_id=$1 ORDER BY created_at DESC LIMIT $2`, [productDetailId, safeLimit]);
    return result.rows;
  }

  async function saveProductTranslation(productDetailId, result) {
    const translated = result.translated;
    const saved = await pool.query(`INSERT INTO product_detail_translations
      (product_detail_id, source_language, target_language, model, source_hash,
       title, description, seller_name, attributes, sku_dimensions, sku_options,
       sku_rows, price_text_candidates, source_data, translated_data, image_sources,
       image_count, naming_strategy, usage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (product_detail_id, target_language, source_hash, model)
      DO UPDATE SET title=EXCLUDED.title, description=EXCLUDED.description,
        seller_name=EXCLUDED.seller_name, attributes=EXCLUDED.attributes,
        sku_dimensions=EXCLUDED.sku_dimensions, sku_options=EXCLUDED.sku_options,
        sku_rows=EXCLUDED.sku_rows, price_text_candidates=EXCLUDED.price_text_candidates,
        source_data=EXCLUDED.source_data, translated_data=EXCLUDED.translated_data,
        image_sources=EXCLUDED.image_sources, image_count=EXCLUDED.image_count,
        naming_strategy=EXCLUDED.naming_strategy,
        usage=EXCLUDED.usage, updated_at=now()
      RETURNING *`, [productDetailId, result.sourceLanguage, result.targetLanguage,
      result.model, result.sourceHash, translated.title, translated.description,
      translated.sellerName, JSON.stringify(translated.attributes),
      JSON.stringify(translated.skuDimensions), JSON.stringify(translated.skuOptions),
      JSON.stringify(translated.skuRows), JSON.stringify(translated.priceTextCandidates),
      JSON.stringify(result.source), JSON.stringify(translated),
      JSON.stringify(result.imageSources ?? []), result.imageSources?.length ?? 0,
      result.namingStrategy ?? 'visual_rewrite', result.usage ? JSON.stringify(result.usage) : null]);
    return saved.rows[0];
  }

  async function listProductTranslations(productDetailId, targetLanguage = null) {
    const values = [productDetailId];
    const languageFilter = targetLanguage ? ' AND target_language=$2' : '';
    if (targetLanguage) values.push(targetLanguage);
    const result = await pool.query(`SELECT * FROM product_detail_translations
      WHERE product_detail_id=$1${languageFilter} ORDER BY created_at DESC`, values);
    return result.rows;
  }

  async function getLatestProductTranslation(productDetailId, targetLanguage = 'en') {
    const result = await pool.query(`SELECT * FROM product_detail_translations
      WHERE product_detail_id=$1 AND target_language=$2
      ORDER BY updated_at DESC, created_at DESC LIMIT 1`, [productDetailId, targetLanguage]);
    return result.rows[0] ?? null;
  }

  async function getWordPressPublication(productDetailId) {
    const result = await pool.query(
      'SELECT * FROM product_wordpress_publications WHERE product_detail_id=$1',
      [productDetailId],
    );
    return result.rows[0] ?? null;
  }

  async function listWordPressPublicationDates() {
    const result = await pool.query(`SELECT publications.product_detail_id,
      publications.wp_post_id, publications.external_id,
      COALESCE(
        (SELECT shop_products.listing_time FROM shop_products
          WHERE shop_products.offer_id = details.offer_id
            AND shop_products.listing_time IS NOT NULL
          ORDER BY shop_products.last_crawled_at DESC LIMIT 1),
        details.first_seen_at
      ) AS publication_date,
      CASE WHEN EXISTS (
        SELECT 1 FROM shop_products
        WHERE shop_products.offer_id = details.offer_id
          AND shop_products.listing_time IS NOT NULL
      ) THEN '1688_listing_time' ELSE 'first_seen_at' END AS publication_date_source
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id = publications.product_detail_id
      WHERE publications.wp_post_id IS NOT NULL
      ORDER BY publications.id`);
    return result.rows;
  }

  async function auditAndRepairProductPrices() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await client.query(`SELECT details.id, details.currency,
        details.price_min, details.price_max, details.raw_data,
        array_remove(array_agg(skus.price ORDER BY skus.id), NULL) AS sku_prices,
        (publications.id IS NOT NULL) AS is_published,
        publications.payload AS publication_payload
        FROM product_details details
        LEFT JOIN product_detail_skus skus ON skus.product_detail_id = details.id
        LEFT JOIN product_wordpress_publications publications
          ON publications.product_detail_id = details.id AND publications.wp_post_id IS NOT NULL
        GROUP BY details.id, publications.id
        ORDER BY details.id`);
      const items = [];
      for (const row of rows.rows) {
        const skuPrices = row.sku_prices ?? [];
        const scopedPriceTexts = row.raw_data?.price?.textCandidates ?? [];
        const derived = deriveVerifiedProductPrice({ skuPrices, scopedPriceTexts });
        if (!derived.verified) {
          items.push({ productDetailId: row.id, published: row.is_published,
            changed: false, verified: false, reason: 'no_exact_saved_sku_or_scoped_price' });
          continue;
        }
        const previousMin = row.price_min == null ? null : Number(row.price_min);
        const previousMax = row.price_max == null ? null : Number(row.price_max);
        const changed = previousMin !== derived.min || previousMax !== derived.max
          || row.raw_data?.price?.verified !== true;
        if (changed) {
          const rawData = row.raw_data ?? {};
          rawData.price = {
            ...(rawData.price ?? {}), min: derived.min, max: derived.max,
            tiers: derived.tiers, source: `stored_${derived.source}`, verified: true,
            repairedFrom: { min: previousMin, max: previousMax },
          };
          await client.query(`UPDATE product_details SET price_min=$1, price_max=$2, raw_data=$3
            WHERE id=$4`, [derived.min, derived.max, JSON.stringify(rawData), row.id]);
          await client.query('DELETE FROM product_detail_price_tiers WHERE product_detail_id=$1', [row.id]);
          for (const tier of derived.tiers) {
            await client.query(`INSERT INTO product_detail_price_tiers
              (product_detail_id, min_quantity, max_quantity, price, currency)
              VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [row.id, tier.minQuantity,
              tier.maxQuantity, tier.price, row.currency ?? 'CNY']);
          }
        }
        const publishedSourceMax = row.publication_payload?.bulk_pricing?.source_max_price;
        const publishedMetaMin = row.publication_payload?.meta?.source_price_min;
        const publishedMetaMax = row.publication_payload?.meta?.source_price_max;
        const publishedSourceMin = row.publication_payload?.source?.price_min;
        const publishedSourceRangeMax = row.publication_payload?.source?.price_max;
        const needsWordPressSync = row.is_published
          && (publishedSourceMax == null || Number(publishedSourceMax) !== Number(derived.max)
            || Number(publishedMetaMin) !== Number(derived.min)
            || Number(publishedMetaMax) !== Number(derived.max)
            || Number(publishedSourceMin) !== Number(derived.min)
            || Number(publishedSourceRangeMax) !== Number(derived.max));
        items.push({ productDetailId: row.id, published: row.is_published, changed, verified: true,
          needsWordPressSync, previousMin, previousMax, min: derived.min, max: derived.max,
          source: derived.source });
      }
      await client.query('COMMIT');
      return {
        total: items.length,
        verified: items.filter((item) => item.verified).length,
        unresolved: items.filter((item) => !item.verified).length,
        changed: items.filter((item) => item.changed).length,
        publishedChanged: items.filter((item) => item.needsWordPressSync).length,
        items,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function saveWordPressPublication(productDetailId, values) {
    const payload = values.payload ?? {};
    const result = values.result ?? {};
    const syncHash = values.syncHash ?? null;
    const saved = await pool.query(`INSERT INTO product_wordpress_publications
      (product_detail_id, translation_id, external_id, style_no, wp_post_id, wp_url,
       wp_edit_url, wp_status, sync_hash, payload, result, last_error,
       first_published_at, last_synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() END,
        CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() END)
      ON CONFLICT (product_detail_id) DO UPDATE SET
        translation_id=EXCLUDED.translation_id, external_id=EXCLUDED.external_id,
        style_no=EXCLUDED.style_no, wp_post_id=COALESCE(EXCLUDED.wp_post_id, product_wordpress_publications.wp_post_id),
        wp_url=COALESCE(EXCLUDED.wp_url, product_wordpress_publications.wp_url),
        wp_edit_url=COALESCE(EXCLUDED.wp_edit_url, product_wordpress_publications.wp_edit_url),
        wp_status=COALESCE(EXCLUDED.wp_status, product_wordpress_publications.wp_status),
        sync_hash=EXCLUDED.sync_hash, payload=EXCLUDED.payload, result=EXCLUDED.result,
        last_error=EXCLUDED.last_error,
        first_published_at=COALESCE(product_wordpress_publications.first_published_at, EXCLUDED.first_published_at),
        last_synced_at=CASE WHEN EXCLUDED.wp_post_id IS NULL
          THEN product_wordpress_publications.last_synced_at ELSE now() END,
        updated_at=now()
      RETURNING *`, [productDetailId, values.translationId ?? null, values.externalId,
      values.styleNo ?? null, values.wpPostId ?? null, values.wpUrl ?? null,
      values.wpEditUrl ?? null, values.wpStatus ?? null, syncHash,
      JSON.stringify(payload), JSON.stringify(result), values.lastError ?? null]);
    return saved.rows[0];
  }

  async function createProductRagSync(productDetailId, values = {}) {
    const saved = await pool.query(`INSERT INTO product_rag_syncs
      (product_detail_id, trigger_type, canonical_product_id, active, request_summary)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`, [productDetailId, values.trigger ?? 'manual',
      values.canonicalProductId ?? null, Boolean(values.active),
      JSON.stringify(values.requestSummary ?? {})]);
    return saved.rows[0];
  }

  async function startProductRagSync(id) {
    const saved = await pool.query(`UPDATE product_rag_syncs SET status='running',
      attempt_count=attempt_count+1, started_at=COALESCE(started_at,now()), error=NULL,
      updated_at=now() WHERE id=$1 RETURNING *`, [id]);
    return saved.rows[0] ?? null;
  }

  async function completeProductRagSync(id, values = {}) {
    const saved = await pool.query(`UPDATE product_rag_syncs SET status='completed',
      canonical_product_id=COALESCE($2,canonical_product_id), active=$3,
      response_summary=$4, error=NULL, completed_at=now(), updated_at=now()
      WHERE id=$1 RETURNING *`, [id, values.canonicalProductId ?? null,
      Boolean(values.active), JSON.stringify(values.responseSummary ?? {})]);
    return saved.rows[0] ?? null;
  }

  async function failProductRagSync(id, error) {
    const saved = await pool.query(`UPDATE product_rag_syncs SET status='failed',
      error=$2, completed_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
    [id, String(error?.message ?? error)]);
    return saved.rows[0] ?? null;
  }

  async function listProductRagSyncs(productDetailId, limit = 20) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const saved = await pool.query(`SELECT * FROM product_rag_syncs
      WHERE product_detail_id=$1 ORDER BY created_at DESC LIMIT $2`, [productDetailId, safeLimit]);
    return saved.rows;
  }

  async function ping() {
    await pool.query('SELECT 1');
  }

  return { pool, migrate, createJob, getJob, claimNextJob, completeJob, upsertShopProfile,
    saveShopScan, listShopProfiles, listShopProducts, saveProductDetail, getProductDetail, listProductDetails,
    findExactGalleryDuplicates, findGalleryHashCandidates, backfillProductImageHashes,
    saveProductVision, listProductVision, saveProductImageCleanup, listProductImageCleanups,
    createProductAudit, startProductAudit, completeProductAudit, failProductAudit, listProductAudits,
    saveProductTranslation, listProductTranslations, getLatestProductTranslation,
    getWordPressPublication, listWordPressPublicationDates, auditAndRepairProductPrices,
    saveWordPressPublication, createProductRagSync, startProductRagSync,
    completeProductRagSync, failProductRagSync, listProductRagSyncs, ping };
}

function parseScore(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/[\d.]+/);
  return match ? Number(match[0]) : null;
}

function parseDate(value) {
  if (!value) return null;
  const match = String(value).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
}

function normalizeOffer(offer) {
  const saleRaw = offer.saleQuantity ?? offer.saleCount ?? offer.soldQuantity ?? offer.sales;
  const saleText = offer.saleQuantityText ?? offer.saleQuantityLabel ?? (typeof saleRaw === 'string' ? saleRaw : null);
  const listingRaw = offer.gmtCreate ?? offer.gmtCreateTime ?? offer.createTime ?? offer.onsaleTime;
  return {
    title: offer.title ?? offer.name ?? null,
    category: offer.categoryName ?? offer.category ?? null,
    price: parseNumber(offer.price ?? offer.agentPrice ?? offer.minPrice),
    currency: offer.currency ?? offer.currencyCode ?? 'CNY',
    imageUrl: offer.picUrl ?? offer.mainImage ?? offer.imageUrl ?? null,
    productUrl: offer.offerUrl ?? offer.url ?? null,
    saleQuantity: parseNumber(saleRaw),
    saleQuantityText: saleText == null ? null : String(saleText),
    listingTime: parseTimestamp(listingRaw),
    shippingInfo: offer.fahuoTime ?? offer.shippingTime ?? offer.label ?? null,
    status: offer.status ?? (offer.isOnline === false ? 'offline' : 'online'),
  };
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).replaceAll(',', '').match(/[\d.]+/);
  return match ? Number(match[0]) : null;
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(/年|\//g, '-').replace(/月/g, '-').replace(/日/g, ''));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
