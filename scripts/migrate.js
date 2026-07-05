const fs = require("fs");
const path = require("path");
const { pool } = require("../db");

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  await pool.query(schema);
  const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (adminEmail) {
    await pool.query(
      `UPDATE users
       SET is_admin = TRUE, approval_status = 'approved'
       WHERE email = $1`,
      [adminEmail]
    );
  }
  console.log("ProjectChat database schema is ready.");
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exitCode = 1;
    });
}

module.exports = migrate;
