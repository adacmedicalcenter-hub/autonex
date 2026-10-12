// Local TEST server with persisted embedded PostgreSQL, for easy Windows pilot setup.
// Transactions serialize on one database connection; use managed PostgreSQL for production.
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import { expire } from "../src/services/workflowService.js";
const root = path.resolve(".pilot-data");
await fs.mkdir(root, { recursive: true });
const secretPath = path.join(root, "secrets.json");
let secrets;
try {
  secrets = JSON.parse(await fs.readFile(secretPath, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  secrets = {
    jwt: randomBytes(32).toString("hex"),
    pin: randomBytes(32).toString("hex"),
  };
  await fs.writeFile(secretPath, JSON.stringify(secrets), { mode: 0o600 });
}
process.env.APP_ENV = "test";
process.env.ALLOW_TEST_TOPUPS = "true";
process.env.JWT_SECRET = secrets.jwt;
process.env.PIN_SECRET = secrets.pin;
const db = new PGlite(path.join(root, "database"));
await db.waitReady;
await db.exec(
  "CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY,executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)"
);
for (const name of (
  await fs.readdir(new URL("../migrations/", import.meta.url))
)
  .filter((n) => n.endsWith(".sql"))
  .sort()) {
  const key = name.replace(".sql", "");
  if (
    (await db.query("SELECT name FROM migrations WHERE name=$1", [key])).rows
      .length
  )
    continue;
  await db.transaction(async (tx) => {
    await tx.exec(
      await fs.readFile(
        new URL("../migrations/" + name, import.meta.url),
        "utf8"
      )
    );
    await tx.query("INSERT INTO migrations(name) VALUES($1)", [key]);
  });
  console.log("Applied", name);
}
if (process.argv[2] === "--admin-phone") {
  const phone = process.argv[3];
  if (!/^\+237[26]\d{8}$/.test(phone || ""))
    throw new Error("Enter a registered +237… phone number");
  const r = await db.query(
    "UPDATE users SET is_admin=TRUE WHERE phone_number=$1 RETURNING id",
    [phone]
  );
  console.log(
    r.rows.length ? "Admin provisioned" : "Register that account first"
  );
  await db.close();
  process.exit(0);
}
let tail = Promise.resolve();
async function lock() {
  const previous = tail;
  let release;
  tail = new Promise((r) => (release = r));
  await previous;
  return release;
}
const pool = {
  query: async (s, p) => {
    const release = await lock();
    try {
      return await db.query(s, p);
    } finally {
      release();
    }
  },
  connect: async () => {
    const release = await lock();
    return { query: (s, p) => db.query(s, p), release };
  },
};
const port = Number(process.env.PORT || 5000);
const server = createApp(pool).listen(port, "0.0.0.0", () =>
  console.log(
    `AutoNex TEST backend: http://localhost:${port}\nSimulated credit only. Use your computer LAN IPv4 address on a phone.`
  )
);
let checking = false;
const timer = setInterval(async () => {
  if (checking) return;
  checking = true;
  try {
    await expire(pool);
  } catch (e) {
    console.error("Expiry check failed", e.message);
  } finally {
    checking = false;
  }
}, 10000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(timer);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  });
