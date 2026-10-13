import "dotenv/config";
import { firebaseSender, drainPush } from "./services/pushService.js";
import pool from "./database/db.js";
import { createApp } from "./app.js";
import { expire } from "./services/workflowService.js";
// Pilot-only entry point. Production enablement needs a separate reviewed configuration.
if (process.env.APP_ENV !== "test")
  throw new Error("APP_ENV=test is required for this pilot backend");
if (
  !process.env.DATABASE_URL ||
  (process.env.JWT_SECRET || "").length < 32 ||
  (process.env.PIN_SECRET || "").length < 32
)
  throw new Error(
    "Set DATABASE_URL and separate JWT_SECRET/PIN_SECRET of at least 32 characters"
  );
const sendPush = await firebaseSender();
console.log(sendPush ? "Firebase TEST sending configured" : "Firebase sending disabled");
const app = createApp(pool, {pushEnabled:Boolean(sendPush)});
const server = app.listen(process.env.PORT || 5000, "0.0.0.0", () =>
  console.log("RESQUORA TEST backend ready")
);
let running = false;
const check = async () => {
  if (running) return;
  running = true;
  try {
    await expire(pool);
  } catch (e) {
    console.error("Expiry worker failed", e.message);
  } finally {
    running = false;
  }
};
let pushing=false;
const pushCheck=async()=> {
 if (pushing) return;
 pushing=true;
 try { await drainPush(pool,sendPush); }
 catch { console.error('Push queue worker failed'); }
 finally { pushing=false; }
};
const pushInterval=setInterval(pushCheck,5000);
pushCheck();
const interval = setInterval(check, 10000);
check();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(interval);
    clearInterval(pushInterval);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
