require("dotenv").config({ path: ".env.local", quiet: true });
require("dotenv").config({ quiet: true });

const { Pool } = process.env.USE_PGMEM === "1"
  ? require("pg-mem").newDb().adapters.createPg()
  : require("pg");

if (!process.env.DATABASE_URL && process.env.USE_PGMEM !== "1") {
  throw new Error("DATABASE_URL is required. Connect a PostgreSQL database before starting ProjectChat.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, transaction };
