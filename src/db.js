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
      data.url, parsedUrl.hostname, company.name ?? null, data.title ?? null,
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

  async function ping() {
    await pool.query('SELECT 1');
  }

  return { pool, migrate, createJob, getJob, claimNextJob, completeJob, upsertShopProfile,
    listShopProfiles, ping };
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
