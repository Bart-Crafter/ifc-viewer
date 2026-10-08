import path from "node:path";
import pg from "pg";

// Accounts, permissions, project links and the audit log live in PostgreSQL:
//  - production: a hosted database (e.g. Neon's free plan) via DATABASE_URL
//  - local development without DATABASE_URL: an embedded Postgres (PGlite) stored under DATA_DIR/pgdata
// Project FILES are not in the database; they live in SharePoint (or a local folder for development).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  drive_id TEXT,
  item_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','client','designer','admin')),
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS conversion_failures (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  version_key TEXT NOT NULL,
  error TEXT,
  ts TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id)
);
CREATE TABLE IF NOT EXISTS audit (
  id BIGSERIAL PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  project_id TEXT,
  file_id TEXT,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_project ON audit(project_id, id DESC);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS link_key TEXT;
CREATE TABLE IF NOT EXISTS register_index (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (project_id, email)
);
CREATE INDEX IF NOT EXISTS register_index_email ON register_index(email);
CREATE TABLE IF NOT EXISTS qr_stamps (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  version_key TEXT NOT NULL,
  rev TEXT,
  stamped_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_id)
);
ALTER TABLE qr_stamps ADD COLUMN IF NOT EXISTS series TEXT;
ALTER TABLE qr_stamps ADD COLUMN IF NOT EXISTS placement TEXT;
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shares_project ON shares(project_id);
CREATE TABLE IF NOT EXISTS share_files (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  folder TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, position)
);
`;

// The old per-user permissions table (memberships) is superseded by each project's access register workbook;
// it is only read once, to seed the register of a project that existed before the register did.

// Wraps a query function so callers get plain rows: all() -> rows, one() -> first row or undefined, run() -> row count.
function wrap(query, tx) {
  return {
    all: async (sql, params = []) => (await query(sql, params)).rows,
    one: async (sql, params = []) => (await query(sql, params)).rows[0],
    run: async (sql, params = []) => (await query(sql, params)).affectedRows ?? 0,
    tx,
  };
}

// Hosted providers (Neon) hand out strings like "...?sslmode=require&channel_binding=require". Keep TLS verification on, state it
// explicitly (silences pg's warning), and drop channel_binding, which some connection paths stall on.
function cleanConnectionString(url) {
  const u = new URL(url);
  if (["require", "prefer", "verify-ca"].includes(u.searchParams.get("sslmode"))) u.searchParams.set("sslmode", "verify-full");
  u.searchParams.delete("channel_binding");
  return u.toString();
}

export async function openDb({ dataDir, url }) {
  let db;
  if (url) {
    // Return int8 (COUNT etc.) as numbers; our values are small.
    pg.types.setTypeParser(20, Number);
    const pool = new pg.Pool({
      connectionString: cleanConnectionString(url),
      max: Number(process.env.DATABASE_POOL_MAX) || 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 20_000,
      query_timeout: 30_000, // never hang forever: a stuck query becomes an error in the log
    });
    console.log(`Connecting to database ${new URL(url).host} ...`);
    pool.on("error", (err) => console.error("Database connection error:", err.message));
    const query = async (sql, params) => {
      const r = await pool.query(sql, params);
      return { rows: r.rows, affectedRows: r.rowCount };
    };
    db = wrap(query, async (fn) => {
      const client = await pool.connect();
      const txQuery = async (sql, params) => {
        const r = await client.query(sql, params);
        return { rows: r.rows, affectedRows: r.rowCount };
      };
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(txQuery, null));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  } else {
    if (process.env.NODE_ENV === "production" && !process.env.ALLOW_EMBEDDED_DB) {
      throw new Error(
        "DATABASE_URL is not set. In production the site needs a hosted Postgres database (see RENDER-DEPLOY.md). " +
          "The embedded test database is for local development only and uses too much memory for a free host."
      );
    }
    const { PGlite } = await import("@electric-sql/pglite");
    const lite = new PGlite(path.join(dataDir, "pgdata"), { parsers: { 20: Number } });
    await lite.waitReady;
    const query = (sql, params) => lite.query(sql, params);
    db = wrap(query, (fn) =>
      lite.transaction((t) => fn(wrap((sql, params) => t.query(sql, params), null)))
    );
    db.close = () => lite.close();
    console.log("No DATABASE_URL set: using a local embedded database (development only).");
  }
  await db.run("SELECT 1");
  console.log("Database connected.");
  for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.run(statement);
  console.log("Database ready.");
  return db;
}
