import "dotenv/config";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pool from "../src/database/db.js";
if (process.env.APP_ENV !== "test")
  throw new Error(
    "Migrations require APP_ENV=test. Do not run against production."
  );
const c = await pool.connect();
try {
  await c.query("SELECT pg_advisory_lock(982314)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS migrations(id SERIAL PRIMARY KEY,name TEXT UNIQUE NOT NULL,executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
  );
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const name of (await fs.readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const key = name.replace(".sql", "");
    if (
      (await c.query("SELECT id FROM migrations WHERE name=$1", [key])).rows
        .length
    )
      continue;
    await c.query("BEGIN");
    try {
      await c.query(await fs.readFile(dir + name, "utf8"));
      await c.query("INSERT INTO migrations(name) VALUES($1)", [key]);
      await c.query("COMMIT");
      console.log("Applied", name);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  }
} finally {
  await c.query("SELECT pg_advisory_unlock(982314)");
  c.release();
  await pool.end();
}
