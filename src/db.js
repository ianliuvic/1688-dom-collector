import pg from 'pg';

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

  async function saveProductDetail(data, sourceUrl, imageFiles = []) {
    if (!data || data.pageType !== 'product' || !sourceUrl) return null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = data.offerId
        ? await client.query('SELECT id FROM product_details WHERE offer_id = $1 OR source_url = $2 LIMIT 1', [String(data.offerId), sourceUrl])
        : await client.query('SELECT id FROM product_details WHERE source_url = $1 LIMIT 1', [sourceUrl]);
      const price = data.price ?? {};
      let detailId;
      if (existing.rows[0]) {
        detailId = existing.rows[0].id;
        await client.query(`UPDATE product_details SET offer_id=$1, source_url=$2, canonical_url=$3,
          title=$4, description=$5, currency=$6, price_min=$7, price_max=$8, moq=$9,
          seller_name=$10, seller_url=$11, raw_data=$12, last_crawled_at=now() WHERE id=$13`, [
          data.offerId ? String(data.offerId) : null, sourceUrl, data.canonicalUrl ?? null,
          data.title ?? null, data.description ?? null, data.currency ?? null,
          price.min ?? null, price.max ?? null, data.moq ?? null,
          data.seller?.name ?? null, data.seller?.url ?? null, JSON.stringify(data), detailId,
        ]);
        await client.query('DELETE FROM product_detail_images WHERE product_detail_id=$1', [detailId]);
        await client.query('DELETE FROM product_detail_skus WHERE product_detail_id=$1', [detailId]);
        await client.query('DELETE FROM product_detail_attributes WHERE product_detail_id=$1', [detailId]);
        await client.query('DELETE FROM product_detail_price_tiers WHERE product_detail_id=$1', [detailId]);
      } else {
        const inserted = await client.query(`INSERT INTO product_details
          (offer_id, source_url, canonical_url, title, description, currency, price_min, price_max, moq, seller_name, seller_url, raw_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [
          data.offerId ? String(data.offerId) : null, sourceUrl, data.canonicalUrl ?? null,
          data.title ?? null, data.description ?? null, data.currency ?? null,
          price.min ?? null, price.max ?? null, data.moq ?? null,
          data.seller?.name ?? null, data.seller?.url ?? null, JSON.stringify(data),
        ]);
        detailId = inserted.rows[0].id;
      }
      for (const image of imageFiles) {
        await client.query(`INSERT INTO product_detail_images
          (product_detail_id, image_type, sort_order, source_url, storage_path, mime_type, downloaded_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [detailId, image.type, image.sortOrder ?? 0,
          image.sourceUrl, image.storagePath ?? null, image.mimeType ?? null,
          image.storagePath ? new Date() : null]);
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
    const detail = await pool.query('SELECT * FROM product_details WHERE id = $1', [id]);
    if (!detail.rows[0]) return null;
    const [images, skus, attributes, tiers] = await Promise.all([
      pool.query('SELECT * FROM product_detail_images WHERE product_detail_id = $1 ORDER BY image_type, sort_order', [id]),
      pool.query('SELECT * FROM product_detail_skus WHERE product_detail_id = $1 ORDER BY id', [id]),
      pool.query('SELECT * FROM product_detail_attributes WHERE product_detail_id = $1 ORDER BY sort_order', [id]),
      pool.query('SELECT * FROM product_detail_price_tiers WHERE product_detail_id = $1 ORDER BY min_quantity NULLS FIRST', [id]),
    ]);
    return { ...detail.rows[0], images: images.rows, skus: skus.rows,
      attributes: attributes.rows, priceTiers: tiers.rows };
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

  async function ping() {
    await pool.query('SELECT 1');
  }

  return { pool, migrate, createJob, getJob, claimNextJob, completeJob, upsertShopProfile,
    saveShopScan, listShopProfiles, listShopProducts, saveProductDetail, getProductDetail,
    saveProductVision, listProductVision, ping };
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
