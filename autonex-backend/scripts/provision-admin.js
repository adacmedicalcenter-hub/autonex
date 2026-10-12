import "dotenv/config";
import pool from "../src/database/db.js";
const phone = process.argv[2];
if (process.env.APP_ENV !== "test" || !/^\+237[26]\d{8}$/.test(phone || ""))
  throw new Error("Usage: APP_ENV=test node scripts/provision-admin.js +237…");
const r = await pool.query(
  "UPDATE users SET is_admin=TRUE WHERE phone_number=$1 RETURNING id",
  [phone]
);
console.log(
  r.rowCount === 1 ? "Admin provisioned" : "Register that account first"
);
await pool.end();
