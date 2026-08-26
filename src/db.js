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
    `);
  }

  async function createJob(id, url) {
    const result = await pool.query(
      'INSERT INTO capture_jobs (id, url) VALUES ($1, $2) RETURNING *',
      [id, url],
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
           screenshot_path = $6, error = $7, completed_at = now()
       WHERE id = $1`,
      [id, values.status, values.title, values.finalUrl, values.domPath,
        values.screenshotPath, values.error],
    );
  }

  async function ping() {
    await pool.query('SELECT 1');
  }

  return { pool, migrate, createJob, getJob, claimNextJob, completeJob, ping };
}
