import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import { deriveVerifiedProductPrice } from './parsers/1688-product.js';
import { evaluateShopProductPolicy } from './shop-publication-policy.js';
import { cleanOptionLabel, normalizeDimensionName, normalizeOptionText } from './option-overrides.js';

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
      -- The page module API reports listing times as epoch-millisecond
      -- strings; older inserts stored NULL. Recover them from the raw offer.
      UPDATE shop_products SET listing_time = to_timestamp((raw_data->>'gmtCreate')::numeric / 1000.0)
      WHERE listing_time IS NULL
        AND raw_data->>'gmtCreate' ~ '^[0-9]{13}$';
      ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS availability_status text NOT NULL DEFAULT 'active';
      ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS last_seen_in_scan_at timestamptz;
      ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS delisted_at timestamptz;
      ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS ingestion_eligible boolean NOT NULL DEFAULT true;
      ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS ingestion_policy text;
      ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS ingestion_reason text;
      CREATE INDEX IF NOT EXISTS shop_products_availability_idx
        ON shop_products (shop_id, availability_status);
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
      -- Restore shop category names from historical scan snapshots for rows
      -- whose category was cleared by a scan source that no longer reports it.
      UPDATE shop_products products SET category = latest.category_name
      FROM (
        SELECT DISTINCT ON (snapshots.shop_product_id)
          snapshots.shop_product_id,
          NULLIF(COALESCE(snapshots.raw_data->>'categoryName', snapshots.raw_data->>'category'), '') AS category_name
        FROM shop_product_snapshots snapshots
        WHERE NULLIF(COALESCE(snapshots.raw_data->>'categoryName', snapshots.raw_data->>'category'), '') IS NOT NULL
        ORDER BY snapshots.shop_product_id, snapshots.observed_at DESC
      ) latest
      WHERE products.id = latest.shop_product_id
        AND (products.category IS NULL OR products.category = '');
      UPDATE shop_products products SET
        ingestion_eligible = COALESCE(products.category IN ('沙滩防晒服', '沙滩裙、沙滩套装'), false),
        ingestion_policy = 'yipin_swim_coverups_only',
        ingestion_reason = CASE
          WHEN products.category IN ('沙滩防晒服', '沙滩裙、沙滩套装') THEN NULL
          ELSE 'source_category_is_not_swim_coverup'
        END
      FROM shop_profiles shops
      WHERE shops.id=products.shop_id AND lower(shops.domain)='shop478x140nz9144.1688.com';
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
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS bundle_status text;
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS bundle_analysis jsonb;
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS bundle_checked_at timestamptz;
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS bundle_manual_status text;
      ALTER TABLE product_details ADD COLUMN IF NOT EXISTS bundle_manual_at timestamptz;
      CREATE INDEX IF NOT EXISTS product_details_bundle_status_idx
        ON product_details (bundle_status);
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
      ALTER TABLE product_detail_skus ADD COLUMN IF NOT EXISTS sku_id text;
      ALTER TABLE product_detail_skus ADD COLUMN IF NOT EXISTS variant_sku text;
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
      CREATE TABLE IF NOT EXISTS product_split_plans (
        product_detail_id bigint PRIMARY KEY REFERENCES product_details(id) ON DELETE CASCADE,
        plan jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS product_variant_normalizations (
        product_detail_id bigint PRIMARY KEY REFERENCES product_details(id) ON DELETE CASCADE,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        model text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS product_split_contents (
        product_detail_id bigint PRIMARY KEY REFERENCES product_details(id) ON DELETE CASCADE,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        model text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS product_pipeline_runs (
        product_detail_id bigint PRIMARY KEY REFERENCES product_details(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'pending',
        step text,
        publish boolean NOT NULL DEFAULT false,
        result jsonb,
        last_error text,
        started_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
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
      CREATE INDEX IF NOT EXISTS product_wordpress_publications_style_upper_idx
        ON product_wordpress_publications(upper(style_no));
      CREATE INDEX IF NOT EXISTS product_wordpress_publications_url_idx
        ON product_wordpress_publications(wp_url);
      CREATE INDEX IF NOT EXISTS product_wordpress_publications_external_idx
        ON product_wordpress_publications(external_id);
      ALTER TABLE product_wordpress_publications
        ADD COLUMN IF NOT EXISTS status_source text;
      ALTER TABLE product_wordpress_publications
        ADD COLUMN IF NOT EXISTS status_checked_at timestamptz;
      CREATE INDEX IF NOT EXISTS product_wordpress_publications_status_checked_idx
        ON product_wordpress_publications(status_checked_at) WHERE wp_post_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS product_wp_status_events (
        id bigserial PRIMARY KEY,
        product_detail_id bigint REFERENCES product_details(id) ON DELETE SET NULL,
        wp_post_id bigint NOT NULL,
        role text,
        old_status text,
        new_status text,
        source text NOT NULL,
        changed_by text,
        event_at timestamptz,
        received_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS product_wp_status_events_post_idx
        ON product_wp_status_events(wp_post_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS product_wp_status_events_product_idx
        ON product_wp_status_events(product_detail_id, received_at DESC);
      CREATE TABLE IF NOT EXISTS product_blocklist (
        offer_id text PRIMARY KEY,
        product_detail_id bigint,
        style_no text,
        title text,
        wp_post_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        reason text,
        blocked_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS product_shopify_publications (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        shopify_store text NOT NULL,
        shopify_product_gid text NOT NULL,
        shopify_handle text NOT NULL,
        shopify_url text NOT NULL,
        product_status text NOT NULL,
        publication_status text NOT NULL,
        source_wp_post_id bigint,
        source_style_no text,
        sync_hash text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        last_error text,
        first_published_at timestamptz,
        last_synced_at timestamptz NOT NULL DEFAULT now(),
        last_verified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (product_detail_id, shopify_store),
        UNIQUE (shopify_store, shopify_product_gid)
      );
      CREATE INDEX IF NOT EXISTS product_shopify_publications_handle_idx
        ON product_shopify_publications(shopify_store, shopify_handle);
      CREATE INDEX IF NOT EXISTS product_shopify_publications_wp_post_idx
        ON product_shopify_publications(source_wp_post_id);
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
      -- Manual display-name overrides for captured option labels, for example a
      -- bare 1688 merchant code such as 9007. The publisher applies them while
      -- assembling the WordPress payload, so a later capture, translation
      -- refresh, or swatch repair cannot revert a corrected label. The captured
      -- source text is never rewritten, only the published display name.
      CREATE TABLE IF NOT EXISTS product_detail_option_overrides (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL REFERENCES product_details(id) ON DELETE CASCADE,
        dimension_name text NOT NULL DEFAULT 'color',
        source_text text NOT NULL,
        display_label text NOT NULL,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (product_detail_id, dimension_name, source_text)
      );
      CREATE INDEX IF NOT EXISTS product_detail_option_overrides_product_idx
        ON product_detail_option_overrides(product_detail_id, dimension_name);
      -- Portal (portal.wearhongxiu.com client fulfilment portal) catalog
      -- publication tracking. A row records the last WordPress-to-portal catalog
      -- import result for a collector-managed product.
      CREATE TABLE IF NOT EXISTS product_portal_publications (
        id bigserial PRIMARY KEY,
        product_detail_id bigint NOT NULL UNIQUE REFERENCES product_details(id) ON DELETE CASCADE,
        wp_post_id bigint,
        style_no text,
        portal_product_id text,
        portal_status text,
        source_key text,
        portal_url text,
        result jsonb NOT NULL DEFAULT '{}'::jsonb,
        last_error text,
        first_published_at timestamptz,
        last_synced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS product_portal_publications_post_idx
        ON product_portal_publications(wp_post_id);
      -- Main-image perceptual hashes (dHash + pHash) used to skip capturing a
      -- new offer whose first image is exactly the same image as an existing
      -- product.  Rows are imported from the Wearhongxiu published catalog and
      -- maintained by every successful product capture.
      CREATE TABLE IF NOT EXISTS product_image_perceptual_hashes (
        id bigserial PRIMARY KEY,
        offer_id text,
        product_detail_id bigint,
        wp_post_id bigint,
        sku text,
        title text,
        source_url text,
        dhash_hex char(16) NOT NULL,
        phash_hex char(16) NOT NULL,
        origin text NOT NULL DEFAULT 'capture',
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS product_image_perceptual_hashes_offer_idx
        ON product_image_perceptual_hashes(offer_id) WHERE offer_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS product_image_perceptual_hashes_wp_idx
        ON product_image_perceptual_hashes(wp_post_id) WHERE wp_post_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS product_image_perceptual_hashes_hash_idx
        ON product_image_perceptual_hashes(dhash_hex, phash_hex);
    `);

    // A shop can be reached through several equivalent 1688 URLs (homepage,
    // offer-list page, vanity domain).  Older rows used shop_url as the only
    // identity, which allowed the same member_id to be stored more than once
    // and made a later full scan look like an entirely new inventory.  Merge
    // those historical rows before enforcing the stable 1688 member identity.
    const duplicateMembers = await pool.query(`
      SELECT member_id
      FROM shop_profiles
      WHERE member_id IS NOT NULL AND btrim(member_id) <> ''
      GROUP BY member_id
      HAVING count(*) > 1
    `);
    for (const { member_id: memberId } of duplicateMembers.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const profilesResult = await client.query(`
          SELECT *
          FROM shop_profiles
          WHERE member_id=$1
          ORDER BY
            (shop_url = concat('https://', domain, '/')) DESC,
            last_seen_at DESC,
            id DESC
          FOR UPDATE
        `, [memberId]);
        const [canonical, ...duplicates] = profilesResult.rows;
        if (!canonical) {
          await client.query('ROLLBACK');
          continue;
        }

        for (const duplicate of duplicates) {
          const duplicateProducts = await client.query(
            'SELECT * FROM shop_products WHERE shop_id=$1 ORDER BY id FOR UPDATE',
            [duplicate.id],
          );
          for (const product of duplicateProducts.rows) {
            const existing = await client.query(
              'SELECT id, last_crawled_at FROM shop_products WHERE shop_id=$1 AND offer_id=$2 FOR UPDATE',
              [canonical.id, product.offer_id],
            );
            if (existing.rowCount) {
              const canonicalProduct = existing.rows[0];
              await client.query(
                'UPDATE shop_product_snapshots SET shop_product_id=$1 WHERE shop_product_id=$2',
                [canonicalProduct.id, product.id],
              );
              if (new Date(product.last_crawled_at) > new Date(canonicalProduct.last_crawled_at)) {
                await client.query(`
                  UPDATE shop_products SET
                    title=$2, category=$3, price=$4, currency=$5, image_url=$6,
                    product_url=$7, sale_quantity=$8, sale_quantity_text=$9,
                    listing_time=COALESCE($10, listing_time), shipping_info=$11,
                    status=$12, raw_data=$13, availability_status=$14,
                    last_seen_in_scan_at=$15, delisted_at=$16, last_crawled_at=$17,
                    first_seen_at=LEAST(first_seen_at, $18)
                  WHERE id=$1
                `, [canonicalProduct.id, product.title, product.category, product.price,
                  product.currency, product.image_url, product.product_url,
                  product.sale_quantity, product.sale_quantity_text, product.listing_time,
                  product.shipping_info, product.status, product.raw_data,
                  product.availability_status, product.last_seen_in_scan_at,
                  product.delisted_at, product.last_crawled_at, product.first_seen_at]);
              } else {
                await client.query(
                  'UPDATE shop_products SET first_seen_at=LEAST(first_seen_at,$2) WHERE id=$1',
                  [canonicalProduct.id, product.first_seen_at],
                );
              }
              await client.query('DELETE FROM shop_products WHERE id=$1', [product.id]);
            } else {
              await client.query('UPDATE shop_products SET shop_id=$1 WHERE id=$2',
                [canonical.id, product.id]);
            }
          }
          await client.query('UPDATE shop_scan_runs SET shop_id=$1 WHERE shop_id=$2',
            [canonical.id, duplicate.id]);
          await client.query(`
            UPDATE shop_profiles SET
              first_seen_at=LEAST(first_seen_at,$2),
              last_seen_at=GREATEST(last_seen_at,$3)
            WHERE id=$1
          `, [canonical.id, duplicate.first_seen_at, duplicate.last_seen_at]);
          await client.query('DELETE FROM shop_profiles WHERE id=$1', [duplicate.id]);
        }

        const canonicalUrl = `${new URL(canonical.shop_url).origin}/`;
        await client.query(
          'UPDATE shop_profiles SET shop_url=$2, domain=$3 WHERE id=$1',
          [canonical.id, canonicalUrl, new URL(canonicalUrl).hostname],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS shop_profiles_member_id_unique_idx
        ON shop_profiles (member_id)
        WHERE member_id IS NOT NULL AND btrim(member_id) <> ''
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

  async function claimNextJob(queue = 'general') {
    if (!['general', 'product_detail'].includes(queue)) throw new Error('Unsupported capture queue.');
    const result = await pool.query(`
      UPDATE capture_jobs
      SET status = 'running', started_at = now(), error = NULL
      WHERE id = (
        SELECT id FROM capture_jobs
        WHERE status = 'queued' AND (
          ($1 = 'product_detail' AND options->>'mode' = 'product_detail')
          OR ($1 = 'general' AND COALESCE(options->>'mode', '') <> 'product_detail')
        )
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `, [queue]);
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
    const values = [
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
    ];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(`
        SELECT id FROM shop_profiles
        WHERE ($1::text IS NOT NULL AND member_id=$1) OR shop_url=$2
        ORDER BY (member_id=$1) DESC, last_seen_at DESC
        LIMIT 1 FOR UPDATE
      `, [company.memberId ?? null, shopUrl]);
      let result;
      if (existing.rowCount) {
        result = await client.query(`
          UPDATE shop_profiles SET
            shop_url=$2, domain=$3, shop_name=$4, page_title=$5, member_id=$6,
            seller_id=$7, company_id=$8, seller_type=$9, main_category=$10,
            address=$11, established_year=$12, established_date=$13,
            follower_count=$14, offer_count=$15, service_score=$16, repeat_rate=$17,
            fulfillment_rate=$18, years_on_platform=$19, contact_name=$20,
            phone=$21, mobile=$22, fax=$23, wangwang_url=$24,
            offer_list_url=$25, new_offer_list_url=$26, navigation=$27,
            raw_data=$28, last_seen_at=now()
          WHERE id=$1
          RETURNING *
        `, [existing.rows[0].id, ...values]);
      } else {
        result = await client.query(`
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
        `, values);
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function listShopProfiles(limit = 100) {
    const result = await pool.query(
      'SELECT * FROM shop_profiles ORDER BY last_seen_at DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 100, 1), 500)],
    );
    return result.rows;
  }

  async function saveShopScan(jobId, data, { completeInventory = false } = {}) {
    if (!data || data.pageType !== 'shop-offer-collection' || !data.shop) return null;
    const shop = await upsertShopProfile(data.shop);
    const blockedOffers = new Set(await listBlockedOfferIds());
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const previousRows = await client.query(
        'SELECT offer_id, availability_status, category FROM shop_products WHERE shop_id=$1 FOR UPDATE',
        [shop.id],
      );
      const previousCategoryById = new Map(previousRows.rows
        .map((row) => [String(row.offer_id), row.category]));
      const knownBefore = new Set(previousRows.rows.map((row) => String(row.offer_id)));
      const activeBefore = new Set(previousRows.rows
        .filter((row) => row.availability_status !== 'delisted')
        .map((row) => String(row.offer_id)));
      const run = await client.query(`
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
      const seen = new Set();
      const addedOfferIds = [];
      const relistedOfferIds = [];
      let saved = 0;
      for (const offer of data.offers ?? []) {
        const offerId = offer?.offerId == null ? null : String(offer.offerId);
        if (!offerId || seen.has(offerId)) continue;
        seen.add(offerId);
        const isBlocked = blockedOffers.has(offerId);
        // Blocklisted offers never re-enter the added/relisted synchronization;
        // the row itself stays visible for lifecycle reporting only.
        if (!knownBefore.has(offerId)) { if (!isBlocked) addedOfferIds.push(offerId); }
        else if (!activeBefore.has(offerId)) { if (!isBlocked) relistedOfferIds.push(offerId); }
        const product = normalizeOffer(offer);
        // Keep the previously known source category when a scan source stops
        // reporting one, so shop policies stay stable across scans.
        const effectiveCategory = product.category ?? previousCategoryById.get(offerId) ?? null;
        const ingestion = isBlocked
          ? { allowed: false, policy: 'blocklisted', reason: 'offer is on the collector blocklist' }
          : evaluateShopProductPolicy([{ domain: shop.domain, category: effectiveCategory }]);
        const productResult = await client.query(`
          INSERT INTO shop_products (
            shop_id, offer_id, title, category, price, currency, image_url, product_url,
            sale_quantity, sale_quantity_text, listing_time, shipping_info, status, raw_data,
            availability_status, ingestion_eligible, ingestion_policy, ingestion_reason,
            last_seen_in_scan_at, delisted_at, last_crawled_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',$15,$16,$17,now(),NULL,now())
          ON CONFLICT (shop_id, offer_id) DO UPDATE SET
            title=EXCLUDED.title, category=COALESCE(EXCLUDED.category, shop_products.category), price=EXCLUDED.price,
            currency=EXCLUDED.currency, image_url=EXCLUDED.image_url, product_url=EXCLUDED.product_url,
            sale_quantity=EXCLUDED.sale_quantity, sale_quantity_text=EXCLUDED.sale_quantity_text,
            listing_time=COALESCE(EXCLUDED.listing_time, shop_products.listing_time),
            shipping_info=EXCLUDED.shipping_info, status=EXCLUDED.status, raw_data=EXCLUDED.raw_data,
            availability_status='active', ingestion_eligible=EXCLUDED.ingestion_eligible,
            ingestion_policy=EXCLUDED.ingestion_policy, ingestion_reason=EXCLUDED.ingestion_reason,
            last_seen_in_scan_at=now(), delisted_at=NULL,
            last_crawled_at=now()
          RETURNING id
        `, [shop.id, offerId, product.title, product.category, product.price, product.currency,
          product.imageUrl, product.productUrl, product.saleQuantity, product.saleQuantityText,
          product.listingTime, product.shippingInfo, product.status, JSON.stringify(offer),
          ingestion.allowed, ingestion.policy, ingestion.reason]);
        await client.query(`
          INSERT INTO shop_product_snapshots
            (scan_run_id, shop_product_id, title, price, sale_quantity, sale_quantity_text, listing_time, status, raw_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (scan_run_id, shop_product_id) DO NOTHING
        `, [scanRun.id, productResult.rows[0].id, product.title, product.price,
          product.saleQuantity, product.saleQuantityText, product.listingTime,
          product.status, JSON.stringify(offer)]);
        saved += 1;
      }
      const inventoryComplete = completeInventory === true && data.truncated !== true
        && (data.totalCount == null || seen.size >= Number(data.totalCount));
      let removedOfferIds = [];
      if (inventoryComplete) {
        removedOfferIds = [...activeBefore].filter((offerId) => !seen.has(offerId));
        if (removedOfferIds.length) {
          await client.query(`UPDATE shop_products
            SET availability_status='delisted', delisted_at=COALESCE(delisted_at, now()), last_crawled_at=now()
            WHERE shop_id=$1 AND offer_id=ANY($2::text[])`, [shop.id, removedOfferIds]);
        }
      }
      await client.query('COMMIT');
      return {
        shopId: shop.id, scanRunId: scanRun.id, savedProducts: saved,
        inventoryComplete, addedOfferIds, relistedOfferIds, removedOfferIds,
        counts: {
          added: addedOfferIds.length, relisted: relistedOfferIds.length,
          removed: removedOfferIds.length, current: seen.size,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function listShopProducts(shopId, limit = 100) {
    const result = await pool.query(
      'SELECT * FROM shop_products WHERE shop_id = $1 ORDER BY last_crawled_at DESC LIMIT $2',
      [shopId, Math.min(Math.max(Number(limit) || 100, 1), 5000)],
    );
    return result.rows;
  }

  async function listShopProductSources(offerId) {
    const result = await pool.query(`SELECT products.shop_id, products.offer_id,
      products.title, products.category, products.status, products.availability_status,
      shops.domain, shops.shop_name, shops.shop_url
      FROM shop_products products
      JOIN shop_profiles shops ON shops.id=products.shop_id
      WHERE products.offer_id=$1
      ORDER BY products.last_crawled_at DESC`, [String(offerId)]);
    return result.rows;
  }

  async function listBestSellerCandidates() {
    const result = await pool.query(`SELECT DISTINCT ON (publications.wp_post_id)
      shops.id AS shop_id, shops.shop_name, shops.domain,
      products.sale_quantity, products.sale_quantity_text, products.listing_time,
      details.id AS product_detail_id, publications.wp_post_id,
      publications.wp_url, publications.style_no
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id=publications.product_detail_id
      JOIN shop_products products ON products.offer_id=details.offer_id
      JOIN shop_profiles shops ON shops.id=products.shop_id
      WHERE publications.wp_status='publish'
        AND publications.wp_post_id IS NOT NULL
        AND products.availability_status='active'
        AND products.ingestion_eligible=true
      ORDER BY publications.wp_post_id, products.sale_quantity DESC NULLS LAST,
        products.listing_time DESC NULLS LAST, products.last_crawled_at DESC`);
    return result.rows;
  }

  async function saveProductDetail(data, sourceUrl, imageFiles = [], duplicateAnalysis = null, bundleDetection = null) {
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
          duplicate_checked_at=$18, bundle_status=$19, bundle_analysis=$20, bundle_checked_at=$21,
          last_crawled_at=now() WHERE id=$22`, [
          data.offerId ? String(data.offerId) : null, sourceUrl, data.canonicalUrl ?? null,
          data.title ?? null, data.description ?? null, data.currency ?? null,
          price.min ?? null, price.max ?? null, data.moq ?? null,
          data.seller?.name ?? null, data.seller?.url ?? null, JSON.stringify(data),
          galleryProfile.fingerprint ?? null, galleryProfile.sourceImageCount ?? 0,
          Boolean(galleryProfile.verifiedComplete), duplicateAnalysis?.status ?? 'not_checked',
          JSON.stringify(duplicateAnalysis ?? {}), duplicateAnalysis?.checkedAt ?? null,
          bundleDetection?.status ?? null,
          bundleDetection ? JSON.stringify(bundleDetection.analysis ?? {}) : null,
          bundleDetection ? new Date().toISOString() : null,
          detailId,
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
           duplicate_analysis, duplicate_checked_at, bundle_status, bundle_analysis, bundle_checked_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`, [
          data.offerId ? String(data.offerId) : null, sourceUrl, data.canonicalUrl ?? null,
          data.title ?? null, data.description ?? null, data.currency ?? null,
          price.min ?? null, price.max ?? null, data.moq ?? null,
          data.seller?.name ?? null, data.seller?.url ?? null, JSON.stringify(data),
          galleryProfile.fingerprint ?? null, galleryProfile.sourceImageCount ?? 0,
          Boolean(galleryProfile.verifiedComplete), duplicateAnalysis?.status ?? 'not_checked',
          JSON.stringify(duplicateAnalysis ?? {}), duplicateAnalysis?.checkedAt ?? null,
          bundleDetection?.status ?? null,
          bundleDetection ? JSON.stringify(bundleDetection.analysis ?? {}) : null,
          bundleDetection ? new Date().toISOString() : null,
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
          (product_detail_id, sku_key, sku_text, price, stock, option_data, raw_data, sku_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [detailId, String(sku.skuKey ?? sku.skuText ?? index),
          sku.skuText ?? sku.text ?? null, sku.price ?? null, sku.stock ?? null,
          JSON.stringify(sku.options ?? {}), JSON.stringify(sku), sku.skuId ?? null]);
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

  /** Replace the stored detail (description) images for one product detail. */
  async function saveDetailImages(detailId, imageFiles) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM product_detail_images
        WHERE product_detail_id=$1 AND image_type='description'`, [detailId]);
      for (const image of imageFiles ?? []) {
        await client.query(`INSERT INTO product_detail_images
          (product_detail_id, image_type, sort_order, source_url, storage_path, mime_type,
           downloaded_at, content_sha256, byte_size)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [detailId, 'description',
          image.sortOrder ?? 0, image.sourceUrl, image.storagePath ?? null, image.mimeType ?? null,
          image.storagePath ? new Date() : null, image.contentSha256 ?? null, image.byteSize ?? null]);
      }
      await client.query('COMMIT');
      return { saved: (imageFiles ?? []).length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Merge arbitrary fields into a product detail's raw_data (jsonb). */
  async function updateProductRawData(productDetailId, patch) {
    if (!productDetailId || !patch || typeof patch !== 'object') return false;
    const result = await pool.query(`UPDATE product_details
      SET raw_data = coalesce(raw_data, '{}'::jsonb) || $2::jsonb
      WHERE id = $1`, [productDetailId, JSON.stringify(patch)]);
    return result.rowCount > 0;
  }

  /** Merge LinkFox enrichment fields into an existing detail's raw_data.
   * Only raw_data is touched; images, SKU rows and the publish gates keep the
   * original browser capture values. */
  async function updateProductLinkFoxData(productDetailId, extras) {
    if (!productDetailId || !extras || typeof extras !== 'object') return false;
    const result = await pool.query(`UPDATE product_details
      SET raw_data = coalesce(raw_data, '{}'::jsonb) || $2::jsonb
      WHERE id = $1`, [productDetailId, JSON.stringify(extras)]);
    return result.rowCount > 0;
  }

  /** Permanently delete one product detail and every dependent row.
   * Child tables cascade; the perceptual-hash row is removed explicitly.
   * Returns the stored image paths so the caller can clean the media folder. */
  async function deleteProductDetail(productDetailId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const detail = await client.query(
        'SELECT id, offer_id, source_url, title FROM product_details WHERE id=$1 FOR UPDATE',
        [productDetailId],
      );
      if (!detail.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const images = await client.query(
        'SELECT storage_path FROM product_detail_images WHERE product_detail_id=$1', [productDetailId]);
      const hashes = await client.query(`DELETE FROM product_image_perceptual_hashes
        WHERE product_detail_id=$1 OR ($2::text IS NOT NULL AND offer_id=$2)`,
      [productDetailId, detail.rows[0].offer_id]);
      const deleted = await client.query('DELETE FROM product_details WHERE id=$1', [productDetailId]);
      await client.query('COMMIT');
      return {
        id: productDetailId, offerId: detail.rows[0].offer_id,
        sourceUrl: detail.rows[0].source_url, title: detail.rows[0].title,
        imageStoragePaths: images.rows.map((row) => row.storage_path).filter(Boolean),
        hashRowsDeleted: hashes.rowCount, deleted: deleted.rowCount > 0,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function listProductDetails({ offerId = null, limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.max(Number(limit) || 100, 1);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    if (offerId) {
      const result = await pool.query(`SELECT * FROM product_details
        WHERE offer_id=$1 ORDER BY last_crawled_at DESC LIMIT $2 OFFSET $3`,
        [String(offerId), safeLimit, safeOffset]);
      return result.rows;
    }
    const result = await pool.query(`SELECT * FROM product_details
      ORDER BY last_crawled_at DESC LIMIT $1 OFFSET $2`, [safeLimit, safeOffset]);
    return result.rows;
  }

  /** Light catalog listing for the all-products browser page: one row per
   * captured product with its option dimensions (and swatch sources), the
   * main/gallery/sku image list, price range, WordPress publication state,
   * the source shop and 1688 listing status, and the colour-variant count. */
  async function listProductCatalog({ limit = 100, offset = 0, search = '', colors = 0, wp = '',
    bundle = '', shop = '' } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 300);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const colorBucket = [1, 2, 3, 4, 5].includes(Number(colors)) ? Number(colors)
      : (Number(colors) === 6 ? 6 : 0);
    const wpValues = ['publish', 'unpublished'].includes(String(wp)) ? String(wp) : '';
    const bundleValues = ['bundle', 'clear'].includes(String(bundle)) ? String(bundle) : '';
    const shopValues = String(shop || '').trim().slice(0, 24);
    const searchTerm = String(search || '').trim().slice(0, 120);
    const searchParam = searchTerm ? `%${searchTerm}%` : null;
    const dimsJson = `(CASE WHEN jsonb_typeof(details.raw_data->'skuDimensions') = 'array'
      THEN details.raw_data->'skuDimensions' ELSE '[]'::jsonb END)`;
    const optsJson = `(CASE WHEN jsonb_typeof(details.raw_data->'skuOptions') = 'array'
      THEN details.raw_data->'skuOptions' ELSE '[]'::jsonb END)`;
    const colorExpr = `COALESCE(
      (SELECT CASE WHEN jsonb_typeof(dim->'values') = 'array' THEN jsonb_array_length(dim->'values') ELSE 0 END
        FROM jsonb_array_elements(${dimsJson}) AS dim
        WHERE (dim->>'name') ~* '(颜色|color|colour)' LIMIT 1),
      (SELECT count(DISTINCT opt->>'text')
        FROM jsonb_array_elements(${optsJson}) AS opt
        WHERE (opt->>'dimensionName') ~* '(颜色|color|colour)'),
      CASE WHEN jsonb_array_length(${dimsJson}) > 0 OR jsonb_array_length(${optsJson}) > 0 THEN 1 ELSE 0 END)`;
    const base = `WITH base AS (
      SELECT details.id, details.offer_id, details.title,
        details.price_min, details.price_max, details.currency, details.moq,
        details.bundle_status, details.bundle_manual_status,
        details.first_seen_at, details.last_crawled_at,
        details.raw_data->'skuOptions' AS sku_options,
        details.raw_data->'skuDimensions' AS sku_dimensions,
        publications.style_no, publications.wp_status, publications.wp_url,
        publications.status_source AS wp_status_source,
        publications.status_checked_at AS wp_status_checked_at,
        portal.portal_product_id, portal.portal_status, portal.last_error AS portal_error,
        portal.result->>'target' AS portal_target, portal.last_synced_at AS portal_synced_at,
        source.shop_id, source.shop_name, source.availability_status, source.delisted_at,
        EXISTS (SELECT 1 FROM product_split_plans plans WHERE plans.product_detail_id=details.id) AS has_split_plan,
        ${colorExpr} AS color_count
      FROM product_details details
      LEFT JOIN product_wordpress_publications publications ON publications.product_detail_id=details.id
      LEFT JOIN product_portal_publications portal ON portal.product_detail_id=details.id
      LEFT JOIN LATERAL (
        SELECT products.shop_id,
          coalesce(shops.shop_name, shops.domain, '未关联店铺') AS shop_name,
          products.availability_status, products.delisted_at
        FROM shop_products products
        LEFT JOIN shop_profiles shops ON shops.id = products.shop_id
        WHERE details.offer_id IS NOT NULL AND products.offer_id = details.offer_id
        ORDER BY products.last_crawled_at DESC
        LIMIT 1
      ) source ON true
      WHERE ($1::text IS NULL OR details.title ILIKE $1 OR details.offer_id ILIKE $1
        OR publications.style_no ILIKE $1 OR publications.external_id ILIKE $1))`;
    // Build a filter set with dynamically numbered placeholders. search ($1)
    // is always part of the base CTE, so extra values start at $2.
    const filtersFor = ({ color, wp: useWp, bundle: useBundle, shop: useShop }) => {
      const values = [searchParam];
      const parts = [];
      if (color) {
        values.push(colorBucket);
        const p = `$${values.length}`;
        parts.push(`(${p}::int = 0 OR (${p}::int = 6 AND color_count >= 6)
          OR (${p}::int BETWEEN 1 AND 5 AND color_count = ${p}))`);
      }
      if (useWp) {
        values.push(wpValues);
        const p = `$${values.length}`;
        parts.push(`(${p}::text = ''
          OR (${p}::text = 'publish' AND coalesce(wp_status, 'none') = 'publish')
          OR (${p}::text = 'unpublished' AND coalesce(wp_status, 'none') <> 'publish'))`);
      }
      if (useBundle) {
        values.push(bundleValues);
        const p = `$${values.length}`;
        parts.push(`(${p}::text = ''
          OR (${p}::text = 'bundle' AND bundle_status = 'bundle')
          OR (${p}::text = 'clear' AND coalesce(bundle_status, 'clear') <> 'bundle'))`);
      }
      if (useShop) {
        values.push(shopValues);
        const p = `$${values.length}`;
        parts.push(`(${p}::text = ''
          OR (${p}::text = 'none' AND shop_id IS NULL)
          OR (${p}::text ~ '^[0-9]+$' AND shop_id::text = ${p}::text))`);
      }
      return { values, where: parts.length ? parts.join(' AND ') : 'true' };
    };

    const main = filtersFor({ color: true, wp: true, bundle: true, shop: true });
    const counts = await pool.query(`${base} SELECT count(*)::int AS total FROM base WHERE ${main.where}`,
      main.values);
    const all = await pool.query(`${base} SELECT count(*)::int AS total FROM base`, [searchParam]);
    const col = filtersFor({ wp: true, bundle: true, shop: true });
    const distribution = await pool.query(
      `${base} SELECT LEAST(color_count, 6) AS bucket, count(*)::int AS products
        FROM base WHERE ${col.where} GROUP BY 1 ORDER BY 1`, col.values);
    const wpq = filtersFor({ color: true, bundle: true, shop: true });
    const wpRows = await pool.query(
      `${base} SELECT CASE WHEN coalesce(wp_status,'none') = 'publish' THEN 'publish' ELSE 'unpublished' END AS bucket,
        count(*)::int AS products FROM base WHERE ${wpq.where} GROUP BY 1`, wpq.values);
    const bq = filtersFor({ color: true, wp: true, shop: true });
    const bundleRows = await pool.query(
      `${base} SELECT CASE WHEN bundle_status = 'bundle' THEN 'bundle' ELSE 'clear' END AS bucket,
        count(*)::int AS products FROM base WHERE ${bq.where} GROUP BY 1`, bq.values);
    const sq = filtersFor({ color: true, wp: true, bundle: true });
    const shopRows = await pool.query(
      `${base} SELECT COALESCE(shop_id::text, 'none') AS bucket, max(shop_name) AS shop_name,
        count(*)::int AS products FROM base WHERE ${sq.where} GROUP BY 1 ORDER BY products DESC`, sq.values);
    const manual = await pool.query(
      'SELECT count(*)::int AS total FROM product_details WHERE bundle_manual_status IS NOT NULL');

    const itemsQ = filtersFor({ color: true, wp: true, bundle: true, shop: true });
    const result = await pool.query(`${base}
      SELECT base.*,
        (SELECT count(*) FROM product_detail_skus skus WHERE skus.product_detail_id=base.id)::int AS sku_rows,
        media.images
      FROM base
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', images.id, 'type', images.image_type,
          'sort', images.sort_order, 'path', images.storage_path, 'source', images.source_url)
          ORDER BY CASE images.image_type WHEN 'main' THEN 0 WHEN 'gallery' THEN 1 ELSE 2 END,
            images.sort_order, images.id) AS images
        FROM product_detail_images images
        WHERE images.product_detail_id=base.id AND images.image_type IN ('main','gallery','sku')
      ) media ON true
      WHERE ${itemsQ.where}
      ORDER BY base.id DESC
      LIMIT $${itemsQ.values.length + 1} OFFSET $${itemsQ.values.length + 2}`,
    [...itemsQ.values, safeLimit, safeOffset]);

    const colorCounts = {};
    for (const row of distribution.rows) colorCounts[String(row.bucket)] = Number(row.products);
    const wpCounts = {};
    for (const row of wpRows.rows) wpCounts[String(row.bucket)] = Number(row.products);
    const bundleCounts = {};
    for (const row of bundleRows.rows) bundleCounts[String(row.bucket)] = Number(row.products);
    return {
      total: all.rows[0]?.total ?? 0,
      filteredTotal: counts.rows[0]?.total ?? 0,
      colorCounts, wpCounts, bundleCounts,
      shopCounts: shopRows.rows.map((row) => ({
        id: row.bucket, name: row.shop_name || '未关联店铺', products: Number(row.products),
      })),
      manualBundleCount: manual.rows[0]?.total ?? 0,
      limit: safeLimit, offset: safeOffset, items: result.rows,
    };
  }

  async function listDetailsMissingBundleAudit(limit = 500) {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    const result = await pool.query(`SELECT id, title,
      raw_data->'skuOptions' AS sku_options,
      raw_data->'skuDimensions' AS sku_dimensions,
      raw_data->'skuMatrix' AS sku_matrix
      FROM product_details
      WHERE bundle_checked_at IS NULL
      ORDER BY last_crawled_at DESC LIMIT $1`, [safeLimit]);
    return result.rows;
  }

  async function saveProductBundleStatus(productDetailId, detection) {
    // A manual operator decision always wins over the automatic detector, so a
    // re-capture or a rule re-run cannot silently revert it.
    const result = await pool.query(`UPDATE product_details
      SET bundle_status=COALESCE(bundle_manual_status, $2), bundle_analysis=$3, bundle_checked_at=now()
      WHERE id=$1 RETURNING id, bundle_status, bundle_manual_status, bundle_checked_at`,
      [productDetailId, detection?.status ?? null,
        detection ? JSON.stringify(detection.analysis ?? {}) : null]);
    return result.rows[0] ?? null;
  }

  /** Set or clear the manual bundle verdict ('bundle' / 'clear' / null = auto). */
  async function setProductBundleManual(productDetailId, status) {
    if (status === null) {
      const result = await pool.query(`UPDATE product_details
        SET bundle_manual_status=NULL, bundle_manual_at=NULL
        WHERE id=$1 RETURNING id, bundle_status, bundle_manual_status`, [productDetailId]);
      return result.rows[0] ?? null;
    }
    const result = await pool.query(`UPDATE product_details
      SET bundle_manual_status=$2, bundle_manual_at=now(), bundle_status=$2
      WHERE id=$1 RETURNING id, bundle_status, bundle_manual_status, bundle_manual_at`, [productDetailId, status]);
    return result.rows[0] ?? null;
  }

  /** Every product with the stored data needed for a full bundle re-evaluation. */
  async function listBundleRecheckRows({ limit = 400, offset = 0 } = {}) {
    const result = await pool.query(`SELECT id, offer_id, title, bundle_status, bundle_manual_status,
      raw_data->'skuOptions' AS sku_options,
      raw_data->'skuDimensions' AS sku_dimensions,
      raw_data->'skuMatrix' AS sku_matrix
      FROM product_details ORDER BY id LIMIT $1 OFFSET $2`, [limit, offset]);
    return result.rows;
  }

  async function listWeeklyMarketingProducts({ from, to, limit = 24 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 24, 1), 50);
    const result = await pool.query(`SELECT details.id AS product_detail_id,
      details.offer_id, source.listing_time, source.category AS source_category,
      source.shop_name, publications.style_no, publications.wp_post_id,
      publications.wp_url,
      COALESCE(translations.title, publications.payload->>'title', details.title) AS title,
      COALESCE(translations.description, publications.payload->>'description', details.description) AS description,
      COALESCE(publications.payload->'images'->0->>'url', source.image_url) AS image_url
      FROM product_details details
      JOIN product_wordpress_publications publications
        ON publications.product_detail_id=details.id
       AND publications.wp_status='publish'
       AND publications.wp_post_id IS NOT NULL
       AND publications.wp_url IS NOT NULL
      JOIN LATERAL (
        SELECT products.listing_time, products.category, products.image_url,
          shops.shop_name
        FROM shop_products products
        JOIN shop_profiles shops ON shops.id=products.shop_id
        WHERE products.offer_id=details.offer_id
          AND products.listing_time >= $1::timestamptz
          AND products.listing_time < $2::timestamptz
          AND products.availability_status='active'
          AND products.ingestion_eligible=true
        ORDER BY products.last_crawled_at DESC
        LIMIT 1
      ) source ON true
      LEFT JOIN LATERAL (
        SELECT title, description
        FROM product_detail_translations
        WHERE product_detail_id=details.id AND target_language='en'
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      ) translations ON true
      ORDER BY source.listing_time DESC, details.id DESC
      LIMIT $3`, [from, to, safeLimit]);
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

  async function findMainImagePerceptualExactMatches({ offerId, dhashHex, phashHex }) {
    const dhash = String(dhashHex || '').trim().toLowerCase();
    const phash = String(phashHex || '').trim().toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(dhash) || !/^[0-9a-f]{16}$/.test(phash)) return [];
    const result = await pool.query(`SELECT hashes.offer_id, hashes.product_detail_id,
      hashes.wp_post_id, hashes.sku, hashes.title, hashes.source_url, hashes.origin,
      hashes.dhash_hex, hashes.phash_hex,
      details.canonical_url, details.source_url AS detail_source_url
      FROM product_image_perceptual_hashes hashes
      LEFT JOIN product_details details ON details.id = hashes.product_detail_id
      WHERE hashes.dhash_hex=$1 AND hashes.phash_hex=$2
        AND ($3::text IS NULL OR hashes.offer_id IS DISTINCT FROM $3::text)
      ORDER BY hashes.updated_at DESC LIMIT 10`, [dhash, phash, offerId ? String(offerId) : null]);
    return result.rows;
  }

  async function upsertProductMainImageHash({ offerId, productDetailId = null, wpPostId = null,
    sku = null, title = null, sourceUrl = null, dhashHex, phashHex, origin = 'capture' }) {
    const dhash = String(dhashHex || '').trim().toLowerCase();
    const phash = String(phashHex || '').trim().toLowerCase();
    if (!offerId || !/^[0-9a-f]{16}$/.test(dhash) || !/^[0-9a-f]{16}$/.test(phash)) return false;
    await pool.query(`INSERT INTO product_image_perceptual_hashes AS hashes
      (offer_id, product_detail_id, wp_post_id, sku, title, source_url, dhash_hex, phash_hex, origin)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (offer_id) WHERE offer_id IS NOT NULL DO UPDATE SET
        product_detail_id=COALESCE(EXCLUDED.product_detail_id, hashes.product_detail_id),
        wp_post_id=COALESCE(EXCLUDED.wp_post_id, hashes.wp_post_id),
        sku=COALESCE(EXCLUDED.sku, hashes.sku),
        title=COALESCE(EXCLUDED.title, hashes.title),
        source_url=COALESCE(EXCLUDED.source_url, hashes.source_url),
        dhash_hex=EXCLUDED.dhash_hex,
        phash_hex=EXCLUDED.phash_hex,
        origin=EXCLUDED.origin,
        updated_at=now()`,
    [String(offerId), productDetailId, wpPostId, sku, title, sourceUrl, dhash, phash, origin]);
    return true;
  }

  async function backfillPerceptualHashOffers() {
    const result = await pool.query(`UPDATE product_image_perceptual_hashes hashes
      SET offer_id = candidate.offer_id,
          product_detail_id = COALESCE(hashes.product_detail_id, candidate.product_detail_id),
          sku = COALESCE(hashes.sku, candidate.style_no),
          updated_at = now()
      FROM (
        SELECT publications.wp_post_id,
               COALESCE(NULLIF(regexp_replace(publications.external_id, '^1688:', ''), ''),
                 details.offer_id) AS offer_id,
               publications.product_detail_id,
               publications.style_no
        FROM product_wordpress_publications publications
        LEFT JOIN product_details details ON details.id = publications.product_detail_id
      ) candidate
      WHERE hashes.wp_post_id = candidate.wp_post_id
        AND hashes.offer_id IS NULL
        AND candidate.offer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM product_image_perceptual_hashes existing
          WHERE existing.offer_id = candidate.offer_id
        )`);
    return result.rowCount;
  }

  async function importPerceptualHashes(items) {
    const rows = (Array.isArray(items) ? items : [])
      .map((item) => ({
        wpPostId: Number(item?.wpPostId) || null,
        sku: item?.sku ? String(item.sku).slice(0, 120) : null,
        title: item?.title ? String(item.title).slice(0, 400) : null,
        sourceUrl: item?.sourceUrl ? String(item.sourceUrl).slice(0, 800) : null,
        dhashHex: String(item?.dhashHex || '').trim().toLowerCase(),
        phashHex: String(item?.phashHex || '').trim().toLowerCase(),
      }))
      .filter((item) => /^[0-9a-f]{16}$/.test(item.dhashHex)
        && /^[0-9a-f]{16}$/.test(item.phashHex));
    let imported = 0;
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      await pool.query(`INSERT INTO product_image_perceptual_hashes AS hashes
        (wp_post_id, sku, title, source_url, dhash_hex, phash_hex, origin)
        SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[],
          $5::char(16)[], $6::char(16)[], $7::text[])
        ON CONFLICT (wp_post_id) WHERE wp_post_id IS NOT NULL DO UPDATE SET
          sku=COALESCE(EXCLUDED.sku, hashes.sku),
          title=COALESCE(EXCLUDED.title, hashes.title),
          source_url=COALESCE(EXCLUDED.source_url, hashes.source_url),
          dhash_hex=EXCLUDED.dhash_hex,
          phash_hex=EXCLUDED.phash_hex,
          origin=EXCLUDED.origin,
          updated_at=now()`,
      [chunk.map((row) => row.wpPostId), chunk.map((row) => row.sku), chunk.map((row) => row.title),
        chunk.map((row) => row.sourceUrl), chunk.map((row) => row.dhashHex),
        chunk.map((row) => row.phashHex), chunk.map(() => 'import')]);
      imported += chunk.length;
    }
    const backfilled = await backfillPerceptualHashOffers();
    return { imported, backfilled, total: rows.length };
  }

  async function getPerceptualHashSummary() {
    const result = await pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE offer_id IS NOT NULL)::int AS with_offer,
      count(*) FILTER (WHERE wp_post_id IS NOT NULL)::int AS with_wp,
      count(*) FILTER (WHERE origin='import')::int AS imported,
      count(*) FILTER (WHERE origin='capture')::int AS captured
      FROM product_image_perceptual_hashes`);
    return result.rows[0];
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
      values.trigger ?? 'manual', values.model ?? 'deepseek-flash']);
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
    const model = result?.models?.complex ?? result?.models?.vision ?? 'deepseek-flash';
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

  async function recoverPendingProductAudits(limit = 5000) {
    const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 10000);
    await pool.query(`UPDATE product_image_audits
      SET status='queued', started_at=NULL, completed_at=NULL, error=NULL
      WHERE status='running' OR (status='failed' AND error ~*
        '(401|402|403|accessdenied|arrearage|unpurchased|insufficient[_ ]balance|deepseek_api_key is not configured)')`);
    await pool.query(`UPDATE product_sku_audits
      SET status='queued', started_at=NULL, completed_at=NULL, error=NULL
      WHERE status='running' OR (status='failed' AND error ~*
        '(401|402|403|accessdenied|arrearage|unpurchased|insufficient[_ ]balance|deepseek_api_key is not configured)')`);
    const result = await pool.query(`
      SELECT 'image'::text AS audit_type, id, product_detail_id, trigger_type,
        model, status, created_at
      FROM product_image_audits WHERE status='queued'
      UNION ALL
      SELECT 'sku'::text AS audit_type, id, product_detail_id, trigger_type,
        model, status, created_at
      FROM product_sku_audits WHERE status='queued'
      ORDER BY created_at ASC, id ASC
      LIMIT $1`, [safeLimit]);
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

  async function resolveWordPressPublication({ styleNo = null, wpPostId = null, wpUrl = null }) {
    let predicate;
    let values;
    if (styleNo) {
      predicate = 'upper(publications.style_no)=upper($1)';
      values = [styleNo];
    } else if (wpPostId) {
      predicate = 'publications.wp_post_id=$1';
      values = [wpPostId];
    } else if (wpUrl) {
      predicate = '(publications.wp_url=$1 OR publications.wp_url=$2)';
      values = [wpUrl, wpUrl.endsWith('/') ? wpUrl.slice(0, -1) : `${wpUrl}/`];
    } else {
      return [];
    }
    const result = await pool.query(`SELECT publications.id AS publication_id,
      publications.product_detail_id, publications.external_id,
      publications.style_no, publications.wp_post_id, publications.wp_url,
      publications.wp_edit_url, publications.wp_status,
      publications.payload->>'title' AS published_title,
      publications.payload->'category_ids' AS category_ids,
      publications.payload->'tags' AS tags,
      publications.first_published_at, publications.last_synced_at,
      details.offer_id, details.source_url, details.canonical_url,
      details.title AS source_title, details.price_min, details.price_max,
      details.currency,
      (SELECT sum(stock) FROM product_detail_skus
        WHERE product_detail_id=details.id) AS stock_total,
      details.last_crawled_at,
      translations.title AS translated_title,
      translations.description AS translated_description
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id=publications.product_detail_id
      LEFT JOIN LATERAL (
        SELECT title,description FROM product_detail_translations
        WHERE product_detail_id=details.id AND target_language='en'
        ORDER BY updated_at DESC,created_at DESC LIMIT 1
      ) translations ON true
      WHERE ${predicate}
      ORDER BY publications.updated_at DESC`, values);
    return result.rows;
  }

  async function findShopifySource({ wpPostId, styleNo, shopifyStore }) {
    const result = await pool.query(`SELECT details.id AS product_detail_id,
      details.offer_id, publications.wp_post_id, publications.wp_url,
      publications.style_no, shopify.id AS shopify_publication_id,
      shopify.shopify_store, shopify.shopify_product_gid,
      shopify.shopify_handle, shopify.shopify_url, shopify.product_status,
      shopify.publication_status, shopify.first_published_at,
      shopify.last_synced_at, shopify.last_verified_at
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id=publications.product_detail_id
      LEFT JOIN product_shopify_publications shopify
        ON shopify.product_detail_id=details.id AND shopify.shopify_store=$3
      WHERE publications.wp_post_id=$1
        AND upper(publications.style_no)=upper($2)
      ORDER BY shopify.updated_at DESC NULLS LAST`, [wpPostId, styleNo, shopifyStore]);
    return result.rows;
  }

  async function getShopifyPublication(productDetailId, shopifyStore) {
    const result = await pool.query(`SELECT * FROM product_shopify_publications
      WHERE product_detail_id=$1 AND shopify_store=$2`, [productDetailId, shopifyStore]);
    return result.rows[0] ?? null;
  }

  async function saveShopifyPublication(productDetailId, values) {
    const saved = await pool.query(`INSERT INTO product_shopify_publications
      (product_detail_id, shopify_store, shopify_product_gid, shopify_handle,
       shopify_url, product_status, publication_status, source_wp_post_id,
       source_style_no, sync_hash, payload, result, last_error,
       first_published_at, last_synced_at, last_verified_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        CASE WHEN $7='published' THEN now() ELSE NULL END, now(),
        CASE WHEN $14::boolean THEN now() ELSE NULL END)
      ON CONFLICT (product_detail_id, shopify_store) DO UPDATE SET
        shopify_product_gid=EXCLUDED.shopify_product_gid,
        shopify_handle=EXCLUDED.shopify_handle,
        shopify_url=EXCLUDED.shopify_url,
        product_status=EXCLUDED.product_status,
        publication_status=EXCLUDED.publication_status,
        source_wp_post_id=COALESCE(EXCLUDED.source_wp_post_id,
          product_shopify_publications.source_wp_post_id),
        source_style_no=COALESCE(EXCLUDED.source_style_no,
          product_shopify_publications.source_style_no),
        sync_hash=EXCLUDED.sync_hash, payload=EXCLUDED.payload,
        result=EXCLUDED.result, last_error=EXCLUDED.last_error,
        first_published_at=COALESCE(product_shopify_publications.first_published_at,
          EXCLUDED.first_published_at),
        last_synced_at=now(),
        last_verified_at=CASE WHEN $14::boolean THEN now()
          ELSE product_shopify_publications.last_verified_at END,
        updated_at=now()
      RETURNING *`, [productDetailId, values.shopifyStore, values.shopifyProductGid,
      values.shopifyHandle, values.shopifyUrl, values.productStatus,
      values.publicationStatus, values.sourceWpPostId ?? null,
      values.sourceStyleNo ?? null, values.syncHash ?? null,
      JSON.stringify(values.payload ?? {}), JSON.stringify(values.result ?? {}),
      values.lastError ?? null, Boolean(values.verified)]);
    return saved.rows[0];
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

  async function listWordPressArrivalDates() {
    const result = await pool.query(`SELECT publications.product_detail_id,
      publications.wp_post_id, publications.external_id, publications.payload,
      (SELECT shop_products.listing_time FROM shop_products
        WHERE shop_products.offer_id = details.offer_id
          AND shop_products.listing_time IS NOT NULL
        ORDER BY shop_products.last_crawled_at DESC LIMIT 1) AS listing_time
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id = publications.product_detail_id
      WHERE publications.wp_post_id IS NOT NULL
        AND publications.wp_status = 'publish'
      ORDER BY publications.id`);
    return result.rows;
  }

  async function saveWordPressArrivalDate(productDetailId, arrivalDate) {
    const result = await pool.query(`UPDATE product_wordpress_publications
      SET payload=jsonb_set(COALESCE(payload, '{}'::jsonb), '{meta,arrival_date}', to_jsonb($2::text), true),
        updated_at=now()
      WHERE product_detail_id=$1 RETURNING *`, [productDetailId, arrivalDate]);
    return result.rows[0] ?? null;
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
       first_published_at, last_synced_at, status_source, status_checked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() END,
        CASE WHEN $5::bigint IS NULL THEN NULL ELSE now() END,
        CASE WHEN $8::text IS NULL THEN NULL ELSE 'collector' END,
        CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
      ON CONFLICT (product_detail_id) DO UPDATE SET
        translation_id=EXCLUDED.translation_id, external_id=EXCLUDED.external_id,
        style_no=EXCLUDED.style_no, wp_post_id=COALESCE(EXCLUDED.wp_post_id, product_wordpress_publications.wp_post_id),
        wp_url=COALESCE(EXCLUDED.wp_url, product_wordpress_publications.wp_url),
        wp_edit_url=COALESCE(EXCLUDED.wp_edit_url, product_wordpress_publications.wp_edit_url),
        wp_status=COALESCE(EXCLUDED.wp_status, product_wordpress_publications.wp_status),
        status_source=CASE WHEN EXCLUDED.wp_status IS NOT NULL THEN 'collector'
          ELSE product_wordpress_publications.status_source END,
        status_checked_at=CASE WHEN EXCLUDED.wp_status IS NOT NULL THEN now()
          ELSE product_wordpress_publications.status_checked_at END,
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

  // ---- WordPress status truth: events pushed by WP + live reconcile reads ----

  async function recordWordpressStatusEvent({ productDetailId = null, postId, role = null,
    oldStatus = null, newStatus = null, source, changedBy = null, eventAt = null }) {
    const parsedEventAt = eventAt && !Number.isNaN(Date.parse(eventAt))
      ? new Date(eventAt).toISOString() : null;
    await pool.query(`INSERT INTO product_wp_status_events
      (product_detail_id, wp_post_id, role, old_status, new_status, source, changed_by, event_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [productDetailId, postId, role, oldStatus, newStatus, source, changedBy, parsedEventAt]);
  }

  /**
   * Apply one WordPress-side status observation (webhook event or a live
   * reconcile read). The keeper publication wins; otherwise the post is
   * matched against split-content sibling entries. Returns null when the post
   * is not tracked by this collector.
   */
  async function applyWordpressPostStatus({ postId, newStatus, source = 'wp_event',
    changedBy = null, eventAt = null }) {
    const postIdNumber = Number(postId);
    const status = newStatus == null ? null : String(newStatus).trim().slice(0, 40);
    if (!Number.isInteger(postIdNumber) || postIdNumber <= 0 || !status) return null;
    const keeper = await pool.query(
      `SELECT product_detail_id, wp_status FROM product_wordpress_publications
       WHERE wp_post_id = $1 LIMIT 1`, [postIdNumber]);
    if (keeper.rowCount) {
      const productDetailId = keeper.rows[0].product_detail_id;
      const previousStatus = keeper.rows[0].wp_status ?? null;
      const changed = previousStatus !== status;
      if (changed) {
        await pool.query(`UPDATE product_wordpress_publications
          SET wp_status = $2, status_source = $3, status_checked_at = now(), updated_at = now()
          WHERE product_detail_id = $1`, [productDetailId, status, source]);
      } else {
        await pool.query(`UPDATE product_wordpress_publications
          SET status_checked_at = now(),
            status_source = COALESCE(status_source, $2)
          WHERE product_detail_id = $1`, [productDetailId, source]);
      }
      if (changed || source === 'wp_event') {
        await recordWordpressStatusEvent({ productDetailId, postId: postIdNumber,
          role: 'keeper', oldStatus: previousStatus, newStatus: status, source,
          changedBy, eventAt });
      }
      return { role: 'keeper', productDetailId, previousStatus, newStatus: status, changed };
    }
    const sibling = await pool.query(
      `SELECT product_detail_id, result, model FROM product_split_contents
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(result->'products') entry
         WHERE entry->'wp'->>'postId' = $1
       ) LIMIT 1`, [String(postIdNumber)]);
    if (sibling.rowCount) {
      const record = sibling.rows[0];
      const checkedAt = new Date().toISOString();
      let previousStatus = null;
      let matchedProductId = null;
      let matched = false;
      const products = (record.result?.products ?? []).map((product) => {
        const wp = product?.wp ?? null;
        if (!wp || String(wp.postId ?? '') !== String(postIdNumber)) return product;
        matched = true;
        matchedProductId = product.id ?? null;
        previousStatus = wp.status ?? null;
        return { ...product, wp: { ...wp, status, checkedAt, checkedSource: source } };
      });
      if (!matched) return null;
      const changed = previousStatus !== status;
      await saveSplitContents(record.product_detail_id, { ...record.result, products }, record.model);
      if (changed || source === 'wp_event') {
        await recordWordpressStatusEvent({ productDetailId: record.product_detail_id,
          postId: postIdNumber, role: 'sibling', oldStatus: previousStatus,
          newStatus: status, source, changedBy, eventAt });
      }
      return { role: 'sibling', productDetailId: record.product_detail_id,
        productId: matchedProductId, previousStatus, newStatus: status, changed };
    }
    await recordWordpressStatusEvent({ postId: postIdNumber, role: 'unmapped',
      newStatus: status, source, changedBy, eventAt }).catch(() => {});
    return null;
  }

  /** Keeper publications whose WordPress status is due for a live re-check. */
  async function listWordpressStatusReconcileTargets({ staleBefore, limit = 500 } = {}) {
    const result = await pool.query(`SELECT product_detail_id, wp_post_id
      FROM product_wordpress_publications
      WHERE wp_post_id IS NOT NULL
        AND (status_checked_at IS NULL OR status_checked_at < $1)
      ORDER BY status_checked_at NULLS FIRST
      LIMIT $2`, [staleBefore, limit]);
    return result.rows;
  }

  /** Every split-product sibling post with its stored checkedAt (reconcile input). */
  async function listSplitContentWpPostEntries() {
    const rows = await pool.query(`SELECT product_detail_id, result FROM product_split_contents`);
    const entries = [];
    for (const row of rows.rows) {
      for (const product of row.result?.products ?? []) {
        const wp = product?.wp ?? null;
        const postId = Number(wp?.postId);
        if (!Number.isInteger(postId) || postId <= 0) continue;
        // The keeper post is tracked on product_wordpress_publications; only
        // true siblings are reconciled from the split contents.
        if (String(wp?.role ?? '') === 'keeper') continue;
        entries.push({ productDetailId: row.product_detail_id,
          productId: product?.id ?? null, postId, checkedAt: wp?.checkedAt ?? null });
      }
    }
    return entries;
  }

  async function pruneWordpressStatusEvents({ keepDays = 60 } = {}) {
    const days = Math.min(Math.max(Number(keepDays) || 60, 1), 3650);
    const result = await pool.query(
      `DELETE FROM product_wp_status_events
       WHERE received_at < now() - make_interval(days => $1)`, [days]);
    return result.rowCount ?? 0;
  }

  // ---- Collector blocklist: purged offers must never be captured again ----

  async function isOfferBlocked(offerId) {
    const value = String(offerId ?? '').trim();
    if (!value) return null;
    const result = await pool.query('SELECT * FROM product_blocklist WHERE offer_id=$1', [value]);
    return result.rows[0] ?? null;
  }

  async function listBlockedOfferIds() {
    const result = await pool.query('SELECT offer_id FROM product_blocklist');
    return result.rows.map((row) => String(row.offer_id));
  }

  async function listProductBlocklist() {
    const result = await pool.query(`SELECT blocked.*,
      (SELECT count(*)::int FROM product_details details WHERE details.offer_id = blocked.offer_id) AS capture_count
      FROM product_blocklist blocked ORDER BY blocked.created_at DESC`);
    return result.rows;
  }

  async function upsertProductBlocklist({ offerId, productDetailId = null, styleNo = null,
    title = null, wpPostIds = [], reason = null, blockedBy = null }) {
    const value = String(offerId ?? '').trim();
    if (!value) throw new Error('offerId is required for the blocklist.');
    const saved = await pool.query(`INSERT INTO product_blocklist
      (offer_id, product_detail_id, style_no, title, wp_post_ids, reason, blocked_by)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
      ON CONFLICT (offer_id) DO UPDATE SET
        product_detail_id=COALESCE(EXCLUDED.product_detail_id, product_blocklist.product_detail_id),
        style_no=COALESCE(EXCLUDED.style_no, product_blocklist.style_no),
        title=COALESCE(EXCLUDED.title, product_blocklist.title),
        wp_post_ids=EXCLUDED.wp_post_ids,
        reason=COALESCE(EXCLUDED.reason, product_blocklist.reason),
        blocked_by=COALESCE(EXCLUDED.blocked_by, product_blocklist.blocked_by)
      RETURNING *`,
    [value, productDetailId, styleNo, title, JSON.stringify(wpPostIds ?? []), reason, blockedBy]);
    return saved.rows[0];
  }

  async function removeProductBlocklist(offerId) {
    const value = String(offerId ?? '').trim();
    if (!value) return false;
    const result = await pool.query('DELETE FROM product_blocklist WHERE offer_id=$1', [value]);
    if (result.rowCount) {
      // The next scan re-evaluates the shop policy; clearing the blocklisted
      // marker now keeps the product visible on the selection page meanwhile.
      await pool.query(`UPDATE shop_products
        SET ingestion_eligible=true, ingestion_policy=NULL, ingestion_reason=NULL
        WHERE offer_id=$1 AND ingestion_reason LIKE '%blocklist%'`, [value]).catch(() => {});
    }
    return result.rowCount > 0;
  }

  /** Saved captures whose offer is blocklisted (pipeline skip helper). */
  async function listBlockedProductDetailIds(ids) {
    const list = [...new Set((ids ?? []).map(Number).filter((value) => Number.isInteger(value) && value > 0))];
    if (!list.length) return [];
    const result = await pool.query(`SELECT details.id FROM product_details details
      JOIN product_blocklist blocked ON blocked.offer_id=details.offer_id
      WHERE details.id = ANY($1::bigint[])`, [list]);
    return result.rows.map((row) => Number(row.id));
  }

  async function listShopifyPublicationsForDetail(productDetailId) {
    const result = await pool.query(
      'SELECT * FROM product_shopify_publications WHERE product_detail_id=$1 ORDER BY last_synced_at DESC',
      [productDetailId]);
    return result.rows;
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

  async function listProductOptionOverrides(productDetailId) {
    const saved = await pool.query(`SELECT * FROM product_detail_option_overrides
      WHERE product_detail_id=$1 ORDER BY dimension_name, source_text`, [productDetailId]);
    return saved.rows;
  }

  async function upsertProductOptionOverride(productDetailId, values = {}) {
    const dimensionName = normalizeDimensionName(values.dimensionName ?? values.dimension_name);
    const sourceText = normalizeOptionText(values.sourceText ?? values.source_text);
    const displayLabel = cleanOptionLabel(values.displayLabel ?? values.display_label);
    const note = String(values.note ?? '').trim() || null;
    if (!sourceText || !displayLabel) {
      throw new Error('A source option text and a display label are required.');
    }
    const saved = await pool.query(`INSERT INTO product_detail_option_overrides
      (product_detail_id, dimension_name, source_text, display_label, note)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (product_detail_id, dimension_name, source_text) DO UPDATE
        SET display_label=EXCLUDED.display_label, note=EXCLUDED.note, updated_at=now()
      RETURNING *`,
    [productDetailId, dimensionName, sourceText, displayLabel, note]);
    return saved.rows[0] ?? null;
  }

  async function deleteProductOptionOverride(productDetailId, overrideId) {
    const deleted = await pool.query(`DELETE FROM product_detail_option_overrides
      WHERE id=$1 AND product_detail_id=$2 RETURNING *`, [overrideId, productDetailId]);
    return deleted.rows[0] ?? null;
  }

  async function getDashboardStats() {
    const [overview, shops, sourceCategories, listingYears, detailQuality, duplicateStatus,
      images, skus, prices, imageAudits, skuAudits, publications, rag, stylePrefixes,
      tags, recentJobs] = await Promise.all([
      pool.query(`SELECT
        (SELECT count(*)::int FROM shop_profiles) AS shops,
        (SELECT count(DISTINCT domain)::int FROM shop_profiles) AS unique_shop_domains,
        (SELECT count(*)::int FROM shop_products) AS listed_products,
        (SELECT count(DISTINCT offer_id)::int FROM shop_products) AS unique_listed_products,
        (SELECT count(*)::int FROM product_details) AS captured_products,
        (SELECT count(DISTINCT product_detail_id)::int FROM product_detail_translations) AS translated_products,
        (SELECT count(*)::int FROM product_wordpress_publications) AS publication_records,
        (SELECT count(*)::int FROM product_wordpress_publications WHERE wp_status='publish') AS published_products,
        (SELECT count(*)::int FROM product_shopify_publications) AS shopify_publication_records,
        (SELECT count(*)::int FROM product_shopify_publications
          WHERE publication_status='published') AS shopify_published_products,
        (SELECT count(*)::int FROM product_details d WHERE NOT EXISTS
          (SELECT 1 FROM product_wordpress_publications w WHERE w.product_detail_id=d.id)) AS unpublished_captures`),
      pool.query(`SELECT s.id, coalesce(s.shop_name,s.domain) AS shop_name, s.domain,
        count(p.id)::int AS product_count,
        count(*) FILTER (WHERE p.listing_time >= '2024-01-01')::int AS listed_since_2024,
        min(p.listing_time) AS oldest_listing, max(p.listing_time) AS newest_listing,
        max(s.last_seen_at) AS last_seen_at
        FROM shop_profiles s LEFT JOIN shop_products p ON p.shop_id=s.id
        GROUP BY s.id ORDER BY product_count DESC, s.id`),
      pool.query(`SELECT coalesce(nullif(category,''),'未分类') AS category, count(*)::int AS products
        FROM shop_products GROUP BY 1 ORDER BY products DESC, category`),
      pool.query(`SELECT coalesce(extract(year from listing_time)::text,'未知') AS listing_year,
        count(*)::int AS products FROM shop_products GROUP BY 1 ORDER BY listing_year`),
      pool.query(`SELECT count(*) FILTER (WHERE gallery_verified_complete)::int AS gallery_verified_complete,
        count(*) FILTER (WHERE NOT gallery_verified_complete)::int AS gallery_incomplete,
        round(avg(gallery_image_count),2) AS avg_gallery_images,
        min(gallery_image_count)::int AS min_gallery_images,
        max(gallery_image_count)::int AS max_gallery_images,
        count(*) FILTER (WHERE gallery_image_count<=1)::int AS one_or_fewer_gallery,
        count(*) FILTER (WHERE price_min IS NOT NULL OR price_max IS NOT NULL)::int AS with_trusted_price,
        count(*) FILTER (WHERE price_min IS NULL AND price_max IS NULL)::int AS missing_trusted_price,
        count(*) FILTER (WHERE title IS NOT NULL AND title<>'')::int AS with_title,
        min(first_seen_at) AS first_capture_at, max(last_crawled_at) AS last_capture_at
        FROM product_details`),
      pool.query(`SELECT duplicate_status AS status, count(*)::int AS products
        FROM product_details GROUP BY duplicate_status ORDER BY products DESC`),
      pool.query(`SELECT image_type, count(*)::int AS images,
        count(*) FILTER (WHERE storage_path IS NOT NULL)::int AS stored,
        count(DISTINCT product_detail_id)::int AS products
        FROM product_detail_images GROUP BY image_type ORDER BY images DESC`),
      pool.query(`SELECT count(*)::int AS sku_rows,
        count(DISTINCT product_detail_id)::int AS products_with_skus,
        round(avg(price),2) AS avg_sku_price,
        count(*) FILTER (WHERE stock IS NULL)::int AS unknown_stock_rows,
        count(*) FILTER (WHERE stock>0)::int AS positive_stock_rows,
        (SELECT count(DISTINCT product_detail_id)::int FROM product_detail_images WHERE image_type='sku') AS products_with_sku_images
        FROM product_detail_skus`),
      pool.query(`SELECT round(min(coalesce(price_min,price_max)),2) AS min_cny,
        round(percentile_cont(0.5) within group(order by coalesce(price_max,price_min))::numeric,2) AS median_max_cny,
        round(avg(coalesce(price_max,price_min)),2) AS avg_max_cny,
        round(max(coalesce(price_max,price_min)),2) AS max_cny
        FROM product_details WHERE price_min IS NOT NULL OR price_max IS NOT NULL`),
      pool.query(`WITH latest AS (SELECT DISTINCT ON(product_detail_id) * FROM product_image_audits
          ORDER BY product_detail_id,created_at DESC)
        SELECT count(*)::int AS audited,
          count(*) FILTER(WHERE status='completed')::int AS completed,
          count(*) FILTER(WHERE status='failed')::int AS failed,
          count(*) FILTER(WHERE status='completed' AND audit_status='clear')::int AS clear,
          count(*) FILTER(WHERE status='completed' AND audit_status='issues_detected')::int AS issues_detected,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'firstImageCompliant')::boolean,false))::int AS first_image_compliant,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'hasWatermark')::boolean,false))::int AS watermark,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'hasChineseText')::boolean,false))::int AS chinese_text,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'hasDuplicates')::boolean,false))::int AS duplicates,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'hasCollage')::boolean,false))::int AS collage,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'hasBackOrReverse')::boolean,false))::int AS back_or_reverse
        FROM latest`),
      pool.query(`WITH latest AS (SELECT DISTINCT ON(product_detail_id) * FROM product_sku_audits
          ORDER BY product_detail_id,created_at DESC)
        SELECT count(*)::int AS audited,
          count(*) FILTER(WHERE status='completed')::int AS completed,
          count(*) FILTER(WHERE status='failed')::int AS failed,
          count(*) FILTER(WHERE status='completed' AND audit_status='clear')::int AS clear,
          count(*) FILTER(WHERE status='completed' AND audit_status='issues_detected')::int AS issues_detected,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'requires_review')::boolean,false))::int AS requires_review,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'has_bundle_options')::boolean,false))::int AS bundle_options,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'has_multiple_products')::boolean,false))::int AS multiple_products,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'has_nonstandard_sizes')::boolean,false))::int AS nonstandard_sizes,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'has_text_image_mismatch')::boolean,false))::int AS text_image_mismatch,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'has_missing_variant_images')::boolean,false))::int AS missing_variant_images,
          count(*) FILTER(WHERE status='completed' AND coalesce((summary->>'has_nonstandard_variant_names')::boolean,false))::int AS nonstandard_variant_names
        FROM latest`),
      pool.query(`SELECT coalesce(wp_status,'未知') AS status, count(*)::int AS products,
        count(*) FILTER (WHERE wp_url IS NOT NULL)::int AS with_url,
        count(*) FILTER (WHERE last_error IS NOT NULL AND last_error<>'')::int AS with_error,
        count(*) FILTER (WHERE payload ? 'publication_date')::int AS with_source_publication_date
        FROM product_wordpress_publications GROUP BY wp_status ORDER BY products DESC`),
      pool.query(`WITH latest AS (SELECT DISTINCT ON(product_detail_id) product_detail_id,status,active
          FROM product_rag_syncs ORDER BY product_detail_id,created_at DESC)
        SELECT status,active,count(*)::int AS products FROM latest
        GROUP BY status,active ORDER BY products DESC`),
      pool.query(`SELECT coalesce(substring(style_no from '^[A-Z]+'),'未知') AS prefix,
        count(*)::int AS products FROM product_wordpress_publications GROUP BY 1 ORDER BY products DESC`),
      pool.query(`SELECT tag,count(*)::int AS products FROM product_wordpress_publications p,
        LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(payload->'tags')='array'
          THEN payload->'tags' ELSE '[]'::jsonb END) tag
        GROUP BY tag ORDER BY products DESC,tag LIMIT 30`),
      pool.query(`SELECT id,status,coalesce(options->>'mode','dom') AS mode,title,error,
        created_at,started_at,completed_at FROM capture_jobs
        ORDER BY created_at DESC LIMIT 20`),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      overview: overview.rows[0], shops: shops.rows, sourceCategories: sourceCategories.rows,
      listingYears: listingYears.rows, detailQuality: detailQuality.rows[0],
      duplicateStatus: duplicateStatus.rows, images: images.rows, skus: skus.rows[0],
      prices: prices.rows[0], imageAudits: imageAudits.rows[0], skuAudits: skuAudits.rows[0],
      publications: publications.rows, rag: rag.rows, stylePrefixes: stylePrefixes.rows,
      tags: tags.rows, recentJobs: recentJobs.rows,
    };
  }

  // Feeds the read-only review page (`/review`): each captured product with its
  // newest image/SKU audit, the shop row it came from, its publication and RAG
  // state and its saved images. Classification happens in review-queue.js.
  async function listReviewQueue({ limit = 300, days = 30, shopId = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 300, 1), 2000);
    const safeDays = Math.min(Math.max(Number(days) || 30, 1), 3650);
    const normalizedShopId = shopId === null || shopId === undefined || shopId === ''
      ? null : Number(shopId);
    const result = await pool.query(`SELECT details.id, details.offer_id, details.title,
      details.source_url, details.currency, details.price_min, details.price_max,
      details.gallery_verified_complete, details.gallery_image_count,
      details.duplicate_status, details.duplicate_analysis,
      details.first_seen_at, details.last_crawled_at,
      source.shop_id, source.shop_name, source.category AS source_category,
      source.listing_time, source.availability_status, source.ingestion_reason,
      source.ingestion_eligible,
      item_no.item_no,
      image_audit.audit_status AS image_audit_status,
      image_audit.status AS image_audit_run_status,
      image_audit.error AS image_audit_error,
      image_audit.summary AS image_audit_summary,
      image_audit.result AS image_audit_result,
      image_audit.completed_at AS image_audit_completed_at,
      sku_audit.audit_status AS sku_audit_status,
      sku_audit.status AS sku_audit_run_status,
      sku_audit.error AS sku_audit_error,
      sku_audit.summary AS sku_audit_summary,
      sku_audit.result AS sku_audit_result,
      sku_audit.completed_at AS sku_audit_completed_at,
      publication.wp_status, publication.wp_url, publication.style_no,
      publication.last_error AS publication_error,
      rag.active AS rag_active, rag.status AS rag_status,
      images.items AS images
      FROM product_details details
      LEFT JOIN LATERAL (
        SELECT products.shop_id, products.category, products.listing_time,
          products.availability_status, products.ingestion_reason,
          products.ingestion_eligible, shops.shop_name
        FROM shop_products products
        JOIN shop_profiles shops ON shops.id = products.shop_id
        WHERE products.offer_id = details.offer_id
        ORDER BY products.last_crawled_at DESC LIMIT 1
      ) source ON true
      LEFT JOIN LATERAL (
        SELECT attributes.value AS item_no FROM product_detail_attributes attributes
        WHERE attributes.product_detail_id = details.id AND attributes.name = '货号'
        ORDER BY attributes.sort_order LIMIT 1
      ) item_no ON true
      LEFT JOIN LATERAL (
        SELECT audits.audit_status, audits.status, audits.error, audits.summary,
          audits.result, audits.completed_at
        FROM product_image_audits audits
        WHERE audits.product_detail_id = details.id
        ORDER BY audits.created_at DESC LIMIT 1
      ) image_audit ON true
      LEFT JOIN LATERAL (
        SELECT audits.audit_status, audits.status, audits.error, audits.summary,
          audits.result, audits.completed_at
        FROM product_sku_audits audits
        WHERE audits.product_detail_id = details.id
        ORDER BY audits.created_at DESC LIMIT 1
      ) sku_audit ON true
      LEFT JOIN product_wordpress_publications publication
        ON publication.product_detail_id = details.id
      LEFT JOIN LATERAL (
        SELECT syncs.active, syncs.status FROM product_rag_syncs syncs
        WHERE syncs.product_detail_id = details.id
        ORDER BY syncs.created_at DESC LIMIT 1
      ) rag ON true
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', images.id, 'type', images.image_type,
          'sortOrder', images.sort_order, 'sourceUrl', images.source_url,
          'local', images.storage_path IS NOT NULL)
          ORDER BY CASE images.image_type WHEN 'main' THEN 0 WHEN 'gallery' THEN 1 ELSE 2 END,
            images.sort_order) AS items
        FROM product_detail_images images
        WHERE images.product_detail_id = details.id
      ) images ON true
      WHERE details.last_crawled_at >= now() - ($2::int * interval '1 day')
        AND ($3::bigint IS NULL OR source.shop_id = $3::bigint)
      -- Unpublished products come first so a busy window can never truncate the
      -- work that still needs a human; published ones fill the remainder.
      ORDER BY (publication.wp_status IS DISTINCT FROM 'publish') DESC,
        details.last_crawled_at DESC
      LIMIT $1`, [safeLimit, safeDays, normalizedShopId]);
    return result.rows;
  }

  async function getProductImage(id) {
    const result = await pool.query(`SELECT id, product_detail_id, storage_path, mime_type,
      source_url FROM product_detail_images WHERE id=$1`, [id]);
    return result.rows[0] ?? null;
  }

  async function listShopsOverview() {
    const result = await pool.query(`
      SELECT shops.id, shops.shop_name, shops.domain, shops.shop_url, shops.offer_list_url,
        count(products.id) AS product_count,
        count(*) FILTER (WHERE products.availability_status='active') AS active_count,
        count(*) FILTER (WHERE products.availability_status='delisted') AS delisted_count,
        count(*) FILTER (WHERE products.ingestion_eligible) AS eligible_count,
        count(*) FILTER (WHERE details.id IS NOT NULL) AS captured_count,
        count(*) FILTER (WHERE publications.wp_status='publish') AS published_count,
        count(*) FILTER (WHERE publications.id IS NOT NULL AND publications.wp_status<>'publish') AS draft_count,
        count(*) FILTER (WHERE details.id IS NULL) AS not_captured_count,
        max(products.last_crawled_at) AS last_scanned_at
      FROM shop_profiles shops
      LEFT JOIN shop_products products ON products.shop_id=shops.id
      LEFT JOIN product_details details ON details.offer_id=products.offer_id
      LEFT JOIN product_wordpress_publications publications
        ON publications.product_detail_id=details.id
      GROUP BY shops.id
      ORDER BY lower(coalesce(shops.shop_name, shops.domain))
    `);
    return result.rows;
  }

  async function listUnassignedOverview() {
    const result = await pool.query(`
      SELECT count(*) AS captured_count,
        count(*) FILTER (WHERE publications.wp_status='publish') AS published_count,
        count(*) FILTER (WHERE publications.id IS NOT NULL AND publications.wp_status<>'publish') AS draft_count
      FROM product_details details
      LEFT JOIN product_wordpress_publications publications
        ON publications.product_detail_id=details.id
      WHERE NOT EXISTS (
        SELECT 1 FROM shop_products products WHERE products.offer_id=details.offer_id
      )
    `);
    return result.rows[0];
  }

  const overviewProductColumns = `
    products.offer_id, products.title, products.category, products.product_url,
    products.image_url AS shop_image_url, products.price, products.currency,
    products.sale_quantity_text, products.listing_time,
    products.availability_status, products.ingestion_eligible, products.ingestion_reason,
    details.id AS product_detail_id, details.source_url AS detail_source_url,
    details.canonical_url, details.gallery_verified_complete, details.duplicate_status,
    details.last_crawled_at AS detail_last_crawled_at,
    publications.style_no, publications.wp_post_id, publications.wp_url, publications.wp_status,
    portal.portal_product_id, portal.portal_status, portal.portal_url,
    portal.last_synced_at AS portal_synced_at,
    (SELECT images.source_url FROM product_detail_images images
      WHERE images.product_detail_id=details.id AND images.image_type IN ('main','gallery')
      ORDER BY (images.image_type='main') DESC, images.sort_order LIMIT 1) AS detail_image_url
  `;

  function buildOverviewProductFilter({ shopId, unassigned, status, search, availability = 'all',
    eligible = 'all', gallery = 'all', stylePrefix = '' }, values) {
    const predicates = [];
    if (unassigned) {
      predicates.push('NOT EXISTS (SELECT 1 FROM shop_products scoped WHERE scoped.offer_id=details.offer_id)');
    } else {
      values.push(shopId);
      predicates.push(`products.shop_id=$${values.length}`);
    }
    if (status === 'published') predicates.push("publications.wp_status='publish'");
    else if (status === 'draft') predicates.push("publications.id IS NOT NULL AND publications.wp_status<>'publish'");
    else if (status === 'captured') predicates.push('details.id IS NOT NULL');
    else if (status === 'not_captured') predicates.push('details.id IS NULL');
    if (availability === 'active') predicates.push("products.availability_status='active'");
    else if (availability === 'delisted') predicates.push("products.availability_status='delisted'");
    if (eligible === 'true') predicates.push('products.ingestion_eligible=true');
    else if (eligible === 'false') predicates.push('products.ingestion_eligible=false');
    if (gallery === 'complete') predicates.push('details.gallery_verified_complete=true');
    else if (gallery === 'incomplete') {
      predicates.push('details.id IS NOT NULL AND details.gallery_verified_complete=false');
    }
    if (stylePrefix) {
      values.push(`^${stylePrefix}[0-9]`);
      predicates.push(`publications.style_no ~ $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      const token = `$${values.length}`;
      predicates.push(`(products.title ILIKE ${token} OR publications.style_no ILIKE ${token}
        OR products.offer_id LIKE ${token} OR details.title ILIKE ${token})`);
    }
    return predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
  }

  const overviewSorts = {
    listing_desc: `COALESCE(products.listing_time, details.first_seen_at) DESC NULLS LAST,
      products.id DESC NULLS LAST, details.id DESC`,
    listing_asc: `COALESCE(products.listing_time, details.first_seen_at) ASC NULLS LAST,
      products.id ASC NULLS LAST, details.id ASC`,
    sales_desc: `products.sale_quantity DESC NULLS LAST,
      COALESCE(products.listing_time, details.first_seen_at) DESC NULLS LAST, products.id DESC`,
    style_asc: `publications.style_no ASC NULLS LAST,
      COALESCE(products.listing_time, details.first_seen_at) DESC NULLS LAST`,
    title_asc: `COALESCE(products.title, details.title) ASC NULLS LAST,
      COALESCE(products.listing_time, details.first_seen_at) DESC NULLS LAST`,
    crawled_desc: `COALESCE(details.last_crawled_at, products.last_crawled_at) DESC NULLS LAST,
      products.id DESC, details.id DESC`,
  };

  async function listShopOverviewProducts({ shopId = null, unassigned = false, status = 'all',
    search = '', availability = 'all', eligible = 'all', gallery = 'all', stylePrefix = '',
    sort = 'listing_desc', limit = 50, offset = 0 } = {}) {
    const values = [];
    const where = buildOverviewProductFilter(
      { shopId, unassigned, status, search, availability, eligible, gallery, stylePrefix }, values);
    const from = unassigned
      ? `FROM product_details details
         LEFT JOIN shop_products products ON products.offer_id=details.offer_id
         LEFT JOIN product_wordpress_publications publications
           ON publications.product_detail_id=details.id
         LEFT JOIN product_portal_publications portal
           ON portal.product_detail_id=details.id`
      : `FROM shop_products products
         LEFT JOIN product_details details ON details.offer_id=products.offer_id
         LEFT JOIN product_wordpress_publications publications
           ON publications.product_detail_id=details.id
         LEFT JOIN product_portal_publications portal
           ON portal.product_detail_id=details.id`;
    const order = `ORDER BY ${overviewSorts[sort] ?? overviewSorts.listing_desc}`;
    values.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
    values.push(Math.max(Number(offset) || 0, 0));
    const result = await pool.query(`
      SELECT ${overviewProductColumns} ${from} ${where}
      ${order} LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    return result.rows;
  }

  async function countShopOverviewProducts(options = {}) {
    const values = [];
    const where = buildOverviewProductFilter(options, values);
    const from = options.unassigned
      ? `FROM product_details details
         LEFT JOIN shop_products products ON products.offer_id=details.offer_id
         LEFT JOIN product_wordpress_publications publications
           ON publications.product_detail_id=details.id`
      : `FROM shop_products products
         LEFT JOIN product_details details ON details.offer_id=products.offer_id
         LEFT JOIN product_wordpress_publications publications
           ON publications.product_detail_id=details.id`;
    const result = await pool.query(`SELECT count(*) AS total ${from} ${where}`, values);
    return Number(result.rows[0]?.total || 0);
  }

  async function getPortalPublication(productDetailId) {
    const result = await pool.query(
      'SELECT * FROM product_portal_publications WHERE product_detail_id=$1',
      [productDetailId],
    );
    return result.rows[0] ?? null;
  }

  async function savePortalPublication(productDetailId, values) {
    const saved = await pool.query(`
      INSERT INTO product_portal_publications (
        product_detail_id, wp_post_id, style_no, portal_product_id, portal_status,
        source_key, portal_url, result, last_error, first_published_at, last_synced_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
      ON CONFLICT (product_detail_id) DO UPDATE SET
        wp_post_id=EXCLUDED.wp_post_id, style_no=EXCLUDED.style_no,
        portal_product_id=EXCLUDED.portal_product_id, portal_status=EXCLUDED.portal_status,
        source_key=EXCLUDED.source_key, portal_url=EXCLUDED.portal_url,
        result=EXCLUDED.result, last_error=EXCLUDED.last_error,
        first_published_at=COALESCE(product_portal_publications.first_published_at, now()),
        last_synced_at=now(), updated_at=now()
      RETURNING *
    `, [productDetailId, values.wpPostId ?? null, values.styleNo ?? null,
      values.portalProductId ?? null, values.portalStatus ?? null, values.sourceKey ?? null,
      values.portalUrl ?? null, JSON.stringify(values.result ?? {}),
      values.lastError ?? null]);
    return saved.rows[0];
  }

  async function failPortalPublication(productDetailId, error, values = {}) {
    const saved = await pool.query(`
      INSERT INTO product_portal_publications (product_detail_id, wp_post_id, style_no, last_error)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (product_detail_id) DO UPDATE SET
        wp_post_id=COALESCE(EXCLUDED.wp_post_id, product_portal_publications.wp_post_id),
        style_no=COALESCE(EXCLUDED.style_no, product_portal_publications.style_no),
        last_error=EXCLUDED.last_error, updated_at=now()
      RETURNING *
    `, [productDetailId, values.wpPostId ?? null, values.styleNo ?? null, String(error)]);
    return saved.rows[0];
  }

  /** Marks a portal publication as archived after the product was removed from the portal. */
  async function markPortalPublicationArchived(productDetailId) {
    const saved = await pool.query(`
      UPDATE product_portal_publications
      SET portal_status='ARCHIVED', last_error=NULL, last_synced_at=now(), updated_at=now()
      WHERE product_detail_id=$1
      RETURNING *
    `, [productDetailId]);
    return saved.rows[0] ?? null;
  }

  /** Saved bundle split plan for one product detail (manual or LLM). */
  async function getProductSplitPlan(productDetailId) {    const result = await pool.query(
      'SELECT * FROM product_split_plans WHERE product_detail_id=$1', [productDetailId]);
    return result.rows[0] ?? null;
  }

  async function saveProductSplitPlan(productDetailId, plan) {
    const result = await pool.query(`INSERT INTO product_split_plans (product_detail_id, plan, updated_at)
      VALUES ($1,$2,now())
      ON CONFLICT (product_detail_id) DO UPDATE SET plan=EXCLUDED.plan, updated_at=now()
      RETURNING *`, [productDetailId, JSON.stringify(plan)]);
    return result.rows[0];
  }

  /** Stock audit for published products: what their live pages claim vs their payload SKUs. */
  async function auditPublicationStock() {
    const result = await pool.query(`
      SELECT
        count(*)::int AS published,
        count(*) FILTER (WHERE skus.total > 0 AND skus.not_positive = 0)::int AS all_in_stock,
        count(*) FILTER (WHERE skus.total > 0 AND skus.not_positive > 0)::int AS has_zero_or_unknown,
        count(*) FILTER (WHERE skus.total = 0)::int AS no_skus,
        count(*) FILTER (WHERE coalesce(pubs.payload->'meta'->>'sample_available', '') IN ('1', 'true'))::int AS page_sample_available,
        count(*) FILTER (WHERE coalesce(pubs.payload->'meta'->>'sample_available', '') IN ('1', 'true')
          AND (skus.total = 0 OR skus.not_positive > 0))::int AS sample_available_but_not_in_stock,
        count(*) FILTER (WHERE coalesce(pubs.payload->'meta'->>'sample_available', '') NOT IN ('1', 'true')
          AND skus.total > 0 AND skus.not_positive = 0)::int AS not_available_but_in_stock,
        count(*) FILTER (WHERE skus.total > 0 AND skus.not_positive > 0
          AND coalesce(d.raw_data->'gallery'->>'source', '') = 'linkfox')::int AS linkfox_with_zero_or_unknown,
        count(*) FILTER (WHERE coalesce(d.raw_data->'gallery'->>'source', '') = 'linkfox')::int AS linkfox_published
      FROM product_wordpress_publications pubs
      JOIN product_details d ON d.id = pubs.product_detail_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE NOT ((row->>'source_stock') ~ '^[0-9]+(\\.[0-9]+)?$'
                 AND (row->>'source_stock')::numeric > 0))::int AS not_positive
        FROM jsonb_array_elements(coalesce(pubs.payload->'sku_matrix'->'rows', '[]'::jsonb)) AS row
      ) skus ON TRUE
      WHERE pubs.wp_status = 'publish'
    `);
    return result.rows[0] ?? {};
  }

  /** Published pages that still claim "sample available" although their payload SKUs are not all in stock. */
  async function listSampleAvailabilityMismatches(limit = 50) {
    const result = await pool.query(`
      SELECT pubs.style_no, pubs.wp_url, d.id AS product_detail_id, skus.total, skus.not_positive,
        coalesce(pubs.payload->'meta'->>'sample_available', '') AS page_sample_available,
        pubs.last_synced_at
      FROM product_wordpress_publications pubs
      JOIN product_details d ON d.id = pubs.product_detail_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE NOT ((row->>'source_stock') ~ '^[0-9]+(\\.[0-9]+)?$'
                 AND (row->>'source_stock')::numeric > 0))::int AS not_positive
        FROM jsonb_array_elements(coalesce(pubs.payload->'sku_matrix'->'rows', '[]'::jsonb)) AS row
      ) skus ON TRUE
      WHERE pubs.wp_status = 'publish'
        AND coalesce(pubs.payload->'meta'->>'sample_available', '') IN ('1', 'true')
        AND (skus.total = 0 OR skus.not_positive > 0)
      ORDER BY pubs.last_synced_at DESC NULLS LAST
      LIMIT $1`, [Math.min(Math.max(Number(limit) || 50, 1), 200)]);
    return result.rows;
  }

  async function samplePublicationStocks(limit = 8) {
    const result = await pool.query(`
      SELECT pubs.style_no, pubs.wp_url, d.id AS product_detail_id,
        coalesce(d.raw_data->'gallery'->>'source', '') AS gallery_source,
        skus.total, skus.not_positive,
        coalesce(pubs.payload->'meta'->>'sample_available', '') AS page_sample_available
      FROM product_wordpress_publications pubs
      JOIN product_details d ON d.id = pubs.product_detail_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE NOT ((row->>'source_stock') ~ '^[0-9]+(\\.[0-9]+)?$'
                 AND (row->>'source_stock')::numeric > 0))::int AS not_positive
        FROM jsonb_array_elements(coalesce(pubs.payload->'sku_matrix'->'rows', '[]'::jsonb)) AS row
      ) skus ON TRUE
      WHERE pubs.wp_status = 'publish'
      ORDER BY random()
      LIMIT $1`, [Math.min(Math.max(Number(limit) || 8, 1), 50)]);
    return result.rows;
  }

  /** Per-product pipeline state (steps run in a fixed order; resumable). */
  async function getPipelineRun(productDetailId) {
    const result = await pool.query(
      'SELECT * FROM product_pipeline_runs WHERE product_detail_id=$1', [productDetailId]);
    return result.rows[0] ?? null;
  }

  async function upsertPipelineRun(productDetailId, patch = {}) {
    const current = await getPipelineRun(productDetailId);
    const next = {
      status: patch.status ?? current?.status ?? 'pending',
      step: patch.step !== undefined ? patch.step : (current?.step ?? null),
      publish: patch.publish !== undefined ? patch.publish === true : (current?.publish === true),
      result: patch.result !== undefined ? patch.result : (current?.result ?? null),
      lastError: patch.lastError !== undefined ? patch.lastError : (current?.last_error ?? null),
      startedAt: patch.startedAt !== undefined ? patch.startedAt : (current?.started_at ?? null),
    };
    const saved = await pool.query(`INSERT INTO product_pipeline_runs
      (product_detail_id, status, step, publish, result, last_error, started_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (product_detail_id) DO UPDATE SET
        status=EXCLUDED.status, step=EXCLUDED.step, publish=EXCLUDED.publish, result=EXCLUDED.result,
        last_error=EXCLUDED.last_error, started_at=EXCLUDED.started_at, updated_at=now()
      RETURNING *`, [
      productDetailId, next.status, next.step, next.publish,
      next.result === null || next.result === undefined ? null : JSON.stringify(next.result),
      next.lastError, next.startedAt]);
    return saved.rows[0];
  }

  async function listPipelineRuns({ limit = 100, status = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const result = status
      ? await pool.query(`SELECT * FROM product_pipeline_runs WHERE status=$2
          ORDER BY updated_at DESC LIMIT $1`, [safeLimit, status])
      : await pool.query('SELECT * FROM product_pipeline_runs ORDER BY updated_at DESC LIMIT $1', [safeLimit]);
    return result.rows;
  }

  /** Saved variant normalization (swatch text/code/image + standardized sizes). */
  async function getVariantNormalization(productDetailId) {    const result = await pool.query(
      'SELECT * FROM product_variant_normalizations WHERE product_detail_id=$1', [productDetailId]);
    return result.rows[0] ?? null;
  }

  async function saveVariantNormalization(productDetailId, result, model) {
    const saved = await pool.query(`INSERT INTO product_variant_normalizations
      (product_detail_id, result, model, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (product_detail_id) DO UPDATE SET result=EXCLUDED.result, model=EXCLUDED.model, updated_at=now()
      RETURNING *`, [productDetailId, JSON.stringify(result), model ?? null]);
    return saved.rows[0];
  }

  /** Published, non-bundle products eligible for a refresh re-sync. */
  async function listRefreshablePublications({ limit = 3000, offset = 0 } = {}) {
    const result = await pool.query(`SELECT details.id AS product_detail_id
      FROM product_details details
      JOIN product_wordpress_publications publications
        ON publications.product_detail_id = details.id
      WHERE publications.wp_status = 'publish' AND publications.wp_post_id IS NOT NULL
        AND details.bundle_status IS DISTINCT FROM 'bundle'
      ORDER BY details.id LIMIT $1 OFFSET $2`, [limit, offset]);
    return result.rows;
  }

  /** Published bundles that have a split plan + generated contents. */
  async function listSplitPublishableBundles({ limit = 2000, offset = 0 } = {}) {
    const result = await pool.query(`SELECT details.id AS product_detail_id
      FROM product_details details
      JOIN product_wordpress_publications publications
        ON publications.product_detail_id = details.id
      JOIN product_split_plans plans ON plans.product_detail_id = details.id
      JOIN product_split_contents contents ON contents.product_detail_id = details.id
      WHERE publications.wp_status = 'publish' AND publications.wp_post_id IS NOT NULL
      ORDER BY details.id LIMIT $1 OFFSET $2`, [limit, offset]);
    return result.rows;
  }

  /** Merge per-split-product WordPress results (and reviewed copy) into the stored contents. */
  async function mergeSplitContentWpResults(productDetailId, entries) {
    const record = await getSplitContents(productDetailId);
    if (!record?.result?.products) return null;
    const byId = new Map((entries ?? []).map((entry) => [String(entry.productId), entry]));
    const products = record.result.products.map((product) => {
      const entry = byId.get(String(product.id));
      if (!entry) return product;
      const next = { ...product };
      if (entry.wp) next.wp = entry.wp;
      const fields = entry.fields ?? {};
      if (fields.title) next.title = fields.title;
      if (fields.description) next.description = fields.description;
      return next;
    });
    return saveSplitContents(productDetailId, { ...record.result, products }, record.model);
  }

  /** Saved split-product contents (title/description/variants/SKUs per split product). */
  async function getSplitContents(productDetailId) {
    const result = await pool.query(
      'SELECT * FROM product_split_contents WHERE product_detail_id=$1', [productDetailId]);
    return result.rows[0] ?? null;
  }

  async function saveSplitContents(productDetailId, result, model) {
    const saved = await pool.query(`INSERT INTO product_split_contents
      (product_detail_id, result, model, updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (product_detail_id) DO UPDATE SET result=EXCLUDED.result, model=EXCLUDED.model, updated_at=now()
      RETURNING *`, [productDetailId, JSON.stringify(result), model ?? null]);
    return saved.rows[0];
  }

  /** Append one downloaded image row (used when a missing swatch image is fetched later). */
  async function addProductImage(productDetailId, image) {    const result = await pool.query(`INSERT INTO product_detail_images
      (product_detail_id, image_type, sort_order, source_url, storage_path, mime_type,
       downloaded_at, content_sha256, byte_size)
      VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8) RETURNING *`, [
      productDetailId, image.type, image.sortOrder ?? 0, image.sourceUrl,
      image.storagePath ?? null, image.mimeType ?? null,
      image.contentSha256 ?? null, image.byteSize ?? null,
    ]);
    return result.rows[0];
  }

  async function listPortalPublishCandidates({ shopId, since, until, limit = 500 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 500);
    const result = await pool.query(`SELECT details.id AS product_detail_id, details.offer_id,
      details.title, details.bundle_status,
      details.raw_data->'skuDimensions' AS sku_dimensions,
      details.raw_data->'skuMatrix' AS sku_matrix,
      products.availability_status, products.listing_time,
      publications.wp_post_id, publications.style_no, publications.wp_status, publications.wp_url,
      portal.portal_product_id, portal.portal_status, portal.last_synced_at AS portal_synced_at
      FROM product_details details
      JOIN shop_products products ON products.offer_id = details.offer_id
      LEFT JOIN product_wordpress_publications publications ON publications.product_detail_id = details.id
      LEFT JOIN product_portal_publications portal ON portal.product_detail_id = details.id
      WHERE products.shop_id = $1
        AND products.listing_time >= $2::timestamptz
        AND products.listing_time < $3::timestamptz
        AND details.bundle_status = 'clear'
      ORDER BY products.listing_time DESC, details.id DESC
      LIMIT $4`, [shopId, since, until, safeLimit]);
    return result.rows;
  }

  async function listPortalRepairCandidates() {
    const result = await pool.query(`SELECT details.id, details.offer_id, details.title,
      details.bundle_status, details.canonical_url, details.source_url,
      details.raw_data->'skuDimensions' AS sku_dimensions,
      details.raw_data->'skuMatrix' AS sku_matrix,
      publications.wp_post_id, publications.style_no, publications.wp_status, publications.wp_url,
      portal.portal_product_id, portal.portal_status
      FROM product_portal_publications portal
      JOIN product_details details ON details.id=portal.product_detail_id
      LEFT JOIN product_wordpress_publications publications ON publications.product_detail_id=details.id
      WHERE portal.portal_product_id IS NOT NULL
      ORDER BY details.last_crawled_at DESC`);
    return result.rows;
  }

  async function updateProductSkusFromMatrix(productDetailId, { rows, dimensions, skuMatrix, priceMin, priceMax,
    skuOptions = null, source = null }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM product_detail_skus WHERE product_detail_id=$1', [productDetailId]);
      for (const [index, sku] of rows.entries()) {
        await client.query(`INSERT INTO product_detail_skus
          (product_detail_id, sku_key, sku_text, price, stock, option_data, raw_data, sku_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [productDetailId,
          String(sku.skuKey ?? sku.skuText ?? index), sku.skuText ?? null,
          sku.price ?? null, sku.stock ?? null,
          JSON.stringify(sku.options ?? {}), JSON.stringify(sku), sku.skuId ?? null]);
      }
      const updated = await client.query(`UPDATE product_details SET
        raw_data = jsonb_set(jsonb_set(coalesce(raw_data,'{}'::jsonb), '{skuDimensions}', $2::jsonb, true), '{skuMatrix}', $3::jsonb, true),
        price_min = COALESCE($4, price_min), price_max = COALESCE($5, price_max)
        WHERE id=$1 RETURNING id`, [productDetailId,
        JSON.stringify(dimensions ?? []), JSON.stringify(skuMatrix ?? {}),
        Number.isFinite(Number(priceMin)) && Number(priceMin) > 0 ? Number(priceMin) : null,
        Number.isFinite(Number(priceMax)) && Number(priceMax) > 0 ? Number(priceMax) : null]);
      if (Array.isArray(skuOptions) && skuOptions.length) {
        // Replace the stored option dimension (colour x size) only when the
        // caller has a complete option list — this is what the translation and
        // bundle detector read downstream.
        await client.query(`UPDATE product_details SET raw_data = jsonb_set(
          coalesce(raw_data,'{}'::jsonb), '{skuOptions}', $2::jsonb, true) WHERE id=$1`,
        [productDetailId, JSON.stringify(skuOptions)]);
      }
      if (source) {
        await client.query(`UPDATE product_details SET raw_data = jsonb_set(
          coalesce(raw_data,'{}'::jsonb), '{variantRowsSource}', $2::jsonb, true) WHERE id=$1`,
        [productDetailId, JSON.stringify({ source, at: new Date().toISOString(), rows: rows.length })]);
      }
      await client.query('COMMIT');
      return { updated: updated.rowCount > 0, skuCount: rows.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Persist the composed per-variant SKUs (normalized code + size) on the SKU rows. */
  async function updateSkuVariantSkus(productDetailId, entries) {
    if (!Array.isArray(entries) || !entries.length) return { updated: 0 };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let updated = 0;
      for (const entry of entries) {
        const result = await client.query(`UPDATE product_detail_skus SET variant_sku=$3
          WHERE product_detail_id=$1 AND sku_key=$2`, [productDetailId, entry.skuKey, entry.sku]);
        updated += result.rowCount;
      }
      await client.query('COMMIT');
      return { updated };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function summarizeWordPressPublications() {
    const statusRows = await pool.query(`SELECT coalesce(publications.wp_status,'none') AS status, count(*)::int AS products
      FROM product_details details
      LEFT JOIN product_wordpress_publications publications ON publications.product_detail_id=details.id
      GROUP BY 1 ORDER BY products DESC`);
    const shopRows = await pool.query(`SELECT coalesce(shops.shop_name, shops.domain, '未关联店铺') AS shop,
      coalesce(publications.wp_status,'none') AS status, count(*)::int AS products
      FROM product_details details
      LEFT JOIN product_wordpress_publications publications ON publications.product_detail_id=details.id
      LEFT JOIN LATERAL (
        SELECT shop_products.shop_id FROM shop_products
        WHERE shop_products.offer_id=details.offer_id
        ORDER BY shop_products.last_crawled_at DESC LIMIT 1
      ) source ON true
      LEFT JOIN shop_profiles shops ON shops.id=source.shop_id
      GROUP BY 1,2 ORDER BY products DESC`);
    const total = statusRows.rows.reduce((sum, row) => sum + Number(row.products || 0), 0);
    return { total, byStatus: statusRows.rows, byShop: shopRows.rows };
  }

  async function listWordPressPublications({ status = '', search = '', limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.max(Number(limit) || 100, 1);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const searchTerm = String(search || '').trim().slice(0, 120);
    const params = [status ? String(status) : null, searchTerm ? `%${searchTerm}%` : null];
    const where = `($1::text IS NULL OR coalesce(publications.wp_status,'none') = $1)
      AND ($2::text IS NULL OR details.title ILIKE $2 OR publications.style_no ILIKE $2)`;
    const counts = await pool.query(`SELECT count(*)::int AS total
      FROM product_details details
      LEFT JOIN product_wordpress_publications publications ON publications.product_detail_id=details.id
      WHERE ${where}`, params);
    const result = await pool.query(`SELECT details.id AS product_detail_id, details.title,
      publications.style_no, publications.wp_post_id, publications.wp_status, publications.wp_url,
      publications.first_published_at, publications.last_synced_at, publications.last_error,
      coalesce(shops.shop_name, shops.domain) AS shop_name
      FROM product_details details
      LEFT JOIN product_wordpress_publications publications ON publications.product_detail_id=details.id
      LEFT JOIN LATERAL (
        SELECT shop_products.shop_id FROM shop_products
        WHERE shop_products.offer_id=details.offer_id
        ORDER BY shop_products.last_crawled_at DESC LIMIT 1
      ) source ON true
      LEFT JOIN shop_profiles shops ON shops.id=source.shop_id
      WHERE ${where}
      ORDER BY publications.last_synced_at DESC NULLS LAST, details.id DESC
      LIMIT $3 OFFSET $4`, [...params, safeLimit, safeOffset]);
    return { total: counts.rows[0]?.total ?? 0, limit: safeLimit, offset: safeOffset, items: result.rows };
  }

  /** Shortlist of published products for the selection page (filters + paging). */
  async function listSelectionProducts({
    q = '', shopId = '', category1688 = '', categoryWp = '',
    colorMin = null, colorMax = null, sizeMin = null, sizeMax = null,
    saleMin = null, monthlyMin = null, priceMin = null, priceMax = null,
    listedFrom = '', listedTo = '',
    portal = '', sort = 'sales', dir = 'desc', limit = 100, offset = 0,
    portalActiveIds = null,
  } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 300);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const sortKey = ['sales', 'monthly', 'price', 'listing'].includes(String(sort)) ? String(sort) : 'sales';
    const direction = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const num = (value) => {
      if (value === null || value === undefined || String(value).trim() === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const values = [];
    const conditions = [];
    // Live staging catalog ids (when provided) define what "published to portal"
    // means for both the filter and the count.
    const activeIds = Array.isArray(portalActiveIds) ? portalActiveIds.filter((id) => typeof id === 'string' && id) : null;
    let activeParam = null;
    if (activeIds) { values.push(activeIds); activeParam = `$${values.length}`; }
    // Free-text search across style number, WP title, 1688 offer id, WP post id and shop name.
    const searchTerm = String(q ?? '').trim().slice(0, 120);
    if (searchTerm) {
      values.push(`%${searchTerm.replace(/[\\%_]/g, '\\$&')}%`);
      const pattern = `$${values.length}`;
      conditions.push(`(coalesce(style_no, '') ILIKE ${pattern} OR coalesce(offer_id::text, '') ILIKE ${pattern} OR coalesce(wp_post_id::text, '') ILIKE ${pattern} OR coalesce(wp_title, '') ILIKE ${pattern} OR coalesce(shop_name, '') ILIKE ${pattern})`);
    }
    const shopTerm = /^\d+$/.test(String(shopId ?? '').trim()) ? String(shopId).trim() : '';
    if (shopTerm) { values.push(shopTerm); conditions.push(`shop_id::text = $${values.length}`); }
    const cat1688 = String(category1688 ?? '').trim().slice(0, 120);
    if (cat1688) { values.push(cat1688); conditions.push(`shop_category = $${values.length}`); }
    const catWp = String(categoryWp ?? '').trim().slice(0, 120);
    if (catWp) { values.push(catWp); conditions.push(`wp_category = $${values.length}`); }
    const cMin = num(colorMin); if (cMin !== null) { values.push(cMin); conditions.push(`color_count >= $${values.length}`); }
    const cMax = num(colorMax); if (cMax !== null) { values.push(cMax); conditions.push(`color_count <= $${values.length}`); }
    const sMin = num(sizeMin); if (sMin !== null) { values.push(sMin); conditions.push(`size_count >= $${values.length}`); }
    const sMax = num(sizeMax); if (sMax !== null) { values.push(sMax); conditions.push(`size_count <= $${values.length}`); }
    const minSale = num(saleMin); if (minSale !== null) { values.push(minSale); conditions.push(`coalesce(sale_quantity, 0) >= $${values.length}`); }
    const minMonthly = num(monthlyMin); if (minMonthly !== null) { values.push(minMonthly); conditions.push(`coalesce(thirty_book_count, 0) >= $${values.length}`); }
    const minPrice = num(priceMin); if (minPrice !== null) { values.push(minPrice); conditions.push(`coalesce(price_min, 0) >= $${values.length}`); }
    const maxPrice = num(priceMax); if (maxPrice !== null) { values.push(maxPrice); conditions.push(`coalesce(price_min, 0) <= $${values.length}`); }
    const dayValue = (value) => {
      const text = String(value ?? '').trim().slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
    };
    const fromDay = dayValue(listedFrom);
    if (fromDay) { values.push(fromDay); conditions.push(`listing_time >= $${values.length}::date`); }
    const toDay = dayValue(listedTo);
    if (toDay) { values.push(toDay); conditions.push(`listing_time < ($${values.length}::date + 1)`); }
    const portalFilter = ['none', 'published', 'archived', 'failed'].includes(String(portal)) ? String(portal) : '';
    if (portalFilter === 'none') conditions.push(`portal_product_id IS NULL`);
    else if (portalFilter === 'published') conditions.push(activeParam
      ? `portal_product_id = ANY(${activeParam}::text[])`
      : `portal_product_id IS NOT NULL AND portal_error IS NULL AND coalesce(portal_status, '') <> 'ARCHIVED' AND portal_target = 'staging'`);
    else if (portalFilter === 'archived') conditions.push(activeParam
      ? `portal_product_id IS NOT NULL AND portal_error IS NULL AND portal_target = 'staging' AND NOT (portal_product_id = ANY(${activeParam}::text[]))`
      : `portal_product_id IS NOT NULL AND portal_error IS NULL AND portal_status = 'ARCHIVED'`);
    else if (portalFilter === 'failed') conditions.push(`portal_error IS NOT NULL`);
    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderSql = {
      sales: `sale_quantity ${direction} NULLS LAST`,
      monthly: `thirty_book_count ${direction} NULLS LAST`,
      price: `price_min ${direction} NULLS LAST`,
      listing: `listing_time ${direction} NULLS LAST`,
    }[sortKey];
    values.push(safeLimit);
    const limitParam = `$${values.length}`;
    values.push(safeOffset);
    const offsetParam = `$${values.length}`;
    const portalColumns = activeParam
      ? `(portal_product_id IS NOT NULL AND portal_product_id = ANY(${activeParam}::text[])) AS portal_active,
        count(*) FILTER (WHERE portal_product_id = ANY(${activeParam}::text[])) OVER()::int AS portal_published,`
      : `NULL::boolean AS portal_active,
        count(*) FILTER (WHERE portal_product_id IS NOT NULL AND portal_error IS NULL AND coalesce(portal_status, '') <> 'ARCHIVED' AND portal_target = 'staging') OVER()::int AS portal_published,`;
    const result = await pool.query(`WITH pubs AS (
        SELECT publications.product_detail_id, publications.style_no, publications.wp_post_id, publications.wp_url,
          publications.payload, details.offer_id, details.price_min, details.price_max, details.currency,
          CASE WHEN jsonb_typeof(publications.payload->'colors'->'colors') = 'array'
            THEN jsonb_array_length(publications.payload->'colors'->'colors') ELSE 0 END AS color_count,
          COALESCE((SELECT count(*)::int FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(publications.payload->'sizes'->'sizes') = 'array'
                THEN publications.payload->'sizes'->'sizes' ELSE '[]'::jsonb END) AS s
            WHERE NOT (coalesce(s->>'label', s->>'value', '') ~* '(均码|one[[:space:]]*size|free[[:space:]]*size)')), 0) AS size_count,
          publications.payload->'meta'->>'primary_category' AS wp_category,
          publications.payload->>'title' AS wp_title,
          publications.payload->'colors'->'colors' AS colors_json,
          publications.payload->'sizes'->'sizes' AS sizes_json,
          EXISTS (SELECT 1 FROM product_split_plans plans WHERE plans.product_detail_id = publications.product_detail_id) AS is_bundle_keeper
        FROM product_wordpress_publications publications
        JOIN product_details details ON details.id = publications.product_detail_id
        WHERE publications.wp_status = 'publish' AND publications.wp_post_id IS NOT NULL
      ), joined AS (
        SELECT pubs.*,
          src.shop_id, src.shop_name, src.shop_category, src.sale_quantity, src.thirty_book_count,
          src.listing_time, src.availability_status, img.storage_path AS main_storage, img.source_url AS main_source_url,
          portal.portal_product_id, portal.portal_status, portal.last_error AS portal_error,
          portal.last_synced_at::text AS portal_synced_at, portal.result->>'target' AS portal_target
        FROM pubs
        LEFT JOIN LATERAL (
          SELECT products.shop_id, products.category AS shop_category, products.sale_quantity,
            CASE WHEN products.raw_data->>'thirtyBookCount' ~ '^[0-9]+([.][0-9]+)?$'
              THEN (products.raw_data->>'thirtyBookCount')::float8 END AS thirty_book_count,
            products.listing_time, products.availability_status,
            coalesce(shops.shop_name, shops.domain, '未关联店铺') AS shop_name
          FROM shop_products products
          LEFT JOIN shop_profiles shops ON shops.id = products.shop_id
          WHERE products.offer_id = pubs.offer_id
          ORDER BY products.last_crawled_at DESC
          LIMIT 1
        ) src ON true
        LEFT JOIN LATERAL (
          SELECT images.storage_path, images.source_url FROM product_detail_images images
          WHERE images.product_detail_id = pubs.product_detail_id AND images.image_type = 'main'
          ORDER BY images.sort_order ASC
          LIMIT 1
        ) img ON true
        LEFT JOIN product_portal_publications portal ON portal.product_detail_id = pubs.product_detail_id
      )
      SELECT *, count(*) OVER()::int AS total,
        ${portalColumns}
        sale_quantity::float8 AS sale_quantity_float, thirty_book_count::float8 AS thirty_book_float,
        price_min::float8 AS price_min_float, price_max::float8 AS price_max_float
      FROM joined ${whereSql}
      ORDER BY ${orderSql}, product_detail_id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`, values);
    const total = result.rows[0]?.total ?? 0;
    const portalPublished = result.rows[0]?.portal_published ?? 0;
    return { items: result.rows, total, limit: safeLimit, offset: safeOffset, portalPublished };
  }

  /** Distinct shop / category options for the selection page filters. */
  async function listSelectionFacets() {
    const shops = await pool.query(`SELECT DISTINCT src.shop_id, src.shop_name
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id = publications.product_detail_id
      JOIN LATERAL (
        SELECT products.shop_id, coalesce(shops.shop_name, shops.domain) AS shop_name
        FROM shop_products products
        LEFT JOIN shop_profiles shops ON shops.id = products.shop_id
        WHERE products.offer_id = details.offer_id
        ORDER BY products.last_crawled_at DESC LIMIT 1
      ) src ON true
      WHERE publications.wp_status = 'publish' AND publications.wp_post_id IS NOT NULL
      ORDER BY src.shop_name`);
    const scans = await pool.query(`SELECT shop_id, max(last_crawled_at)::text AS last_scan FROM shop_products GROUP BY shop_id`);
    const scanByShop = new Map(scans.rows.map((row) => [String(row.shop_id), row.last_scan]));
    const shopsList = shops.rows.map((row) => ({
      id: row.shop_id === null ? null : String(row.shop_id),
      name: row.shop_name,
      lastScanAt: scanByShop.get(String(row.shop_id)) ?? null,
    }));
    const overall = await pool.query(`SELECT max(last_crawled_at)::text AS last_scan FROM shop_products`);
    const categories1688 = await pool.query(`SELECT DISTINCT products.category
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id = publications.product_detail_id
      JOIN shop_products products ON products.offer_id = details.offer_id
      WHERE publications.wp_status = 'publish' AND publications.wp_post_id IS NOT NULL
        AND products.category IS NOT NULL AND products.category <> ''
      ORDER BY 1`);
    const categoriesWp = await pool.query(`SELECT DISTINCT publications.payload->'meta'->>'primary_category' AS category
      FROM product_wordpress_publications publications
      WHERE publications.wp_status = 'publish' AND publications.wp_post_id IS NOT NULL
        AND publications.payload->'meta'->>'primary_category' IS NOT NULL
      ORDER BY 1`);
    return {
      shops: shopsList,
      categories1688: categories1688.rows.map((row) => row.category),
      categoriesWp: categoriesWp.rows.map((row) => row.category),
      lastScanAt: overall.rows[0]?.last_scan ?? null,
    };
  }

  function selectionImageUrl(offerId, storagePath) {
    const parts = String(storagePath ?? '').split(/[\\/]/).filter(Boolean);
    const fileName = parts.pop() || '';
    let folder = parts.pop() || '';
    if (!/^[A-Za-z0-9._-]{1,180}$/.test(fileName) || fileName.includes('..')) return null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(folder)) folder = /^[A-Za-z0-9_-]{1,64}$/.test(String(offerId ?? '')) ? String(offerId) : '';
    if (!folder) return null;
    return `/api/product-images/${encodeURIComponent(folder)}/${encodeURIComponent(fileName)}`;
  }

  /** Published WP images plus 1688 detail images (stored copies and not-downloaded URLs). */
  async function getSelectionProductMedia(productDetailId) {
    const id = Number(productDetailId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const result = await pool.query(`SELECT publications.style_no, details.offer_id, publications.payload, details.raw_data
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id = publications.product_detail_id
      WHERE publications.product_detail_id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const payload = row.payload ?? {};
    const wpImages = (Array.isArray(payload.images) ? payload.images : [])
      .map((image) => ({ url: image?.url ?? null, sourceUrl: image?.source_url ?? null, alt: image?.alt ?? null }))
      .filter((image) => image.url || image.sourceUrl);
    const stored = await pool.query(`SELECT source_url, storage_path FROM product_detail_images
      WHERE product_detail_id = $1 AND image_type = 'description' ORDER BY sort_order ASC`, [id]);
    const detailImages = [];
    const seen = new Set();
    for (const image of stored.rows) {
      const url = selectionImageUrl(row.offer_id, image.storage_path) ?? image.source_url ?? null;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      detailImages.push({ url, sourceUrl: image.source_url ?? null, stored: true });
    }
    const html = row.raw_data?.linkfox?.raw?.description;
    if (typeof html === 'string' && html) {
      for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
        const url = match[1];
        if (!url || seen.has(url)) continue;
        seen.add(url);
        detailImages.push({ url, sourceUrl: url, stored: false });
      }
    }
    const portalRow = await pool.query(`SELECT portal_product_id, portal_status, last_error,
        last_synced_at::text AS last_synced_at, result
      FROM product_portal_publications WHERE product_detail_id = $1`, [id]);
    const portalPub = portalRow.rows[0] ?? null;
    const savedImages = Array.isArray(portalPub?.result?.mediaImages) && portalPub.result.mediaImages.length
      ? portalPub.result.mediaImages
      : null;
    const savedVariantImages = Array.isArray(portalPub?.result?.variantImages) && portalPub.result.variantImages.length
      ? portalPub.result.variantImages
      : null;
    return {
      productDetailId: id, styleNo: row.style_no, offerId: row.offer_id, wpImages, detailImages,
      portal: portalPub ? {
        productId: portalPub.portal_product_id ?? null,
        status: portalPub.portal_status ?? null,
        error: portalPub.last_error ?? null,
        syncedAt: portalPub.last_synced_at ?? null,
        target: portalPub.result?.target ?? null,
        images: savedImages,
        variantImages: savedVariantImages,
      } : null,
    };
  }

  /** Per-SKU stock (style-colour-size) captured from LinkFox / browser for the selection page. */
  async function getSelectionProductSkus(productDetailId) {
    const id = Number(productDetailId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const publication = await pool.query(`SELECT publications.style_no, details.offer_id, details.last_crawled_at::text AS captured_at
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id = publications.product_detail_id
      WHERE publications.product_detail_id = $1`, [id]);
    const row = publication.rows[0];
    if (!row) return null;
    const result = await pool.query(`SELECT sku_key, sku_text, variant_sku, stock::float8 AS stock, price::float8 AS price,
        option_data, image_source_url, image_storage_path
      FROM product_detail_skus WHERE product_detail_id = $1 ORDER BY id`, [id]);
    const pick = (options, pattern) => {
      for (const [key, value] of Object.entries(options ?? {})) {
        if (pattern.test(String(key)) && value !== null && value !== undefined && String(value).trim() !== '') {
          return String(value).trim();
        }
      }
      return null;
    };
    const skus = result.rows.map((sku) => ({
      skuKey: sku.sku_key,
      variantSku: sku.variant_sku ?? null,
      color: pick(sku.option_data, /(颜色|色|color|colour)/i),
      size: pick(sku.option_data, /(尺码|尺寸|码数|size)/i),
      stock: sku.stock === null || sku.stock === undefined ? null : Number(sku.stock),
      price: sku.price === null || sku.price === undefined ? null : Number(sku.price),
      image: sku.image_storage_path ? selectionImageUrl(row.offer_id, sku.image_storage_path) : (sku.image_source_url ?? null),
    }));
    return { productDetailId: id, styleNo: row.style_no, offerId: row.offer_id, capturedAt: row.captured_at, skus };
  }

  /** Portal-published products whose 1688 listing is now delisted (from shop scans). */
  async function listPortalDelistedProducts() {
    const result = await pool.query(`SELECT publications.style_no, publications.portal_product_id,
        publications.portal_status, publications.result->>'target' AS portal_target,
        wp.wp_status, src.shop_name, src.delisted_at::text AS delisted_at
      FROM product_portal_publications publications
      JOIN product_details details ON details.id = publications.product_detail_id
      LEFT JOIN product_wordpress_publications wp ON wp.product_detail_id = publications.product_detail_id
      JOIN LATERAL (
        SELECT coalesce(shops.shop_name, shops.domain) AS shop_name, products.availability_status,
          products.delisted_at
        FROM shop_products products
        LEFT JOIN shop_profiles shops ON shops.id = products.shop_id
        WHERE products.offer_id = details.offer_id
        ORDER BY products.last_crawled_at DESC
        LIMIT 1
      ) src ON true
      WHERE publications.portal_product_id IS NOT NULL
        AND src.availability_status = 'delisted'
      ORDER BY src.delisted_at DESC NULLS LAST`);
    return result.rows;
  }

  /** Latest 1688 sale quantity per style number / WordPress post id (shop scan data). */
  async function listProductSaleQuantities({ styles = [], wpPostIds = [] } = {}) {
    const styleList = [...new Set((styles ?? []).map((value) => String(value).trim()).filter(Boolean))];
    const postList = [...new Set((wpPostIds ?? []).map((value) => String(value).trim()).filter((value) => /^\d+$/.test(value)))];
    if (!styleList.length && !postList.length) return [];
    const result = await pool.query(`SELECT DISTINCT ON (publications.style_no)
      publications.style_no, publications.wp_post_id, products.offer_id,
      products.sale_quantity, products.sale_quantity_text, products.availability_status,
      shops.shop_name, products.last_crawled_at
      FROM product_wordpress_publications publications
      JOIN product_details details ON details.id=publications.product_detail_id
      JOIN shop_products products ON products.offer_id=details.offer_id
      JOIN shop_profiles shops ON shops.id=products.shop_id
      WHERE publications.style_no = ANY($1) OR publications.wp_post_id = ANY($2::bigint[])
      ORDER BY publications.style_no, products.last_crawled_at DESC NULLS LAST`, [styleList, postList]);
    return result.rows;
  }

  async function ping() {
    await pool.query('SELECT 1');
  }

  return { pool, migrate, createJob, getJob, claimNextJob, completeJob, upsertShopProfile,
    saveShopScan, listShopProfiles, listShopProducts, listShopProductSources,
    listBestSellerCandidates,
    saveProductDetail, getProductDetail, saveDetailImages, listProductDetails, listWeeklyMarketingProducts,
    updateProductLinkFoxData, deleteProductDetail,
    listProductCatalog, listDetailsMissingBundleAudit, saveProductBundleStatus,
    setProductBundleManual, listBundleRecheckRows,
    listPortalPublishCandidates, listPortalRepairCandidates, updateProductSkusFromMatrix,
    summarizeWordPressPublications, listWordPressPublications, listProductSaleQuantities,
    listSelectionProducts, listSelectionFacets, getSelectionProductMedia, getSelectionProductSkus,
    listPortalDelistedProducts,
    auditPublicationStock, samplePublicationStocks, listSampleAvailabilityMismatches,
    findExactGalleryDuplicates, findGalleryHashCandidates, backfillProductImageHashes,
    findMainImagePerceptualExactMatches, upsertProductMainImageHash, importPerceptualHashes,
    getPerceptualHashSummary, backfillPerceptualHashOffers,
    saveProductVision, listProductVision, saveProductImageCleanup, listProductImageCleanups,
    createProductAudit, startProductAudit, completeProductAudit, failProductAudit, listProductAudits,
    recoverPendingProductAudits,
    saveProductTranslation, listProductTranslations, getLatestProductTranslation,
    getWordPressPublication, resolveWordPressPublication, findShopifySource, getShopifyPublication,
    saveShopifyPublication, listWordPressPublicationDates, listWordPressArrivalDates,
    saveWordPressArrivalDate, auditAndRepairProductPrices,
    saveWordPressPublication, applyWordpressPostStatus, recordWordpressStatusEvent,
    listWordpressStatusReconcileTargets, listSplitContentWpPostEntries,
    pruneWordpressStatusEvents,
    isOfferBlocked, listBlockedOfferIds, listProductBlocklist, upsertProductBlocklist,
    removeProductBlocklist, listBlockedProductDetailIds, listShopifyPublicationsForDetail,
    createProductRagSync, startProductRagSync,
    completeProductRagSync, failProductRagSync, listProductRagSyncs, getDashboardStats,
    listProductOptionOverrides, upsertProductOptionOverride, deleteProductOptionOverride,
    getProductSplitPlan, saveProductSplitPlan,
    getPipelineRun, upsertPipelineRun, listPipelineRuns,
    getVariantNormalization, saveVariantNormalization, addProductImage, updateSkuVariantSkus,
    getSplitContents, saveSplitContents, updateProductRawData,
    listRefreshablePublications, listSplitPublishableBundles, mergeSplitContentWpResults,
    listReviewQueue, getProductImage, listShopsOverview, listUnassignedOverview,
    listShopOverviewProducts, countShopOverviewProducts,
    getPortalPublication, savePortalPublication, failPortalPublication, markPortalPublicationArchived, ping };
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
  const raw = String(value).trim();
  if (/^\d{10,13}$/.test(raw)) {
    // Epoch strings (seconds or milliseconds) are not valid Date strings.
    const epoch = new Date(raw.length <= 10 ? Number(raw) * 1000 : Number(raw));
    return Number.isNaN(epoch.getTime()) ? null : epoch.toISOString();
  }
  const date = new Date(String(value).replace(/年|\//g, '-').replace(/月/g, '-').replace(/日/g, ''));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
