import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
});

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id SERIAL PRIMARY KEY,
      source_name TEXT NOT NULL,
      url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      raw_excerpt TEXT,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS changes (
      id SERIAL PRIMARY KEY,
      source_name TEXT NOT NULL,
      url TEXT NOT NULL,
      summary TEXT NOT NULL,
      significance TEXT,
      previous_snapshot_id INTEGER REFERENCES snapshots(id),
      new_snapshot_id INTEGER REFERENCES snapshots(id),
      detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_snapshots_source ON snapshots(source_name, fetched_at DESC);
  `);
}
