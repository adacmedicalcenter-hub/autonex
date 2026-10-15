import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs/promises";
import { createApp } from "../src/app.js";
import { grantWelcomeCredit } from "../src/services/feeService.js";
import { expire } from "../src/services/workflowService.js";
process.env.TZ = "UTC";
process.env.APP_ENV = "test";
process.env.ALLOW_TEST_TOPUPS = "true";
process.env.JWT_SECRET = "test-jwt-secret-with-more-than-32-characters";
process.env.PIN_SECRET =
  "different-test-pin-secret-with-more-than-32-characters";
test("PostgreSQL pilot workflow, ledger and authorization", async (t) => {
  const db = new PGlite();
  await db.waitReady;
  for (const n of (await fs.readdir(new URL("../migrations/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(
      await fs.readFile(new URL("../migrations/" + n, import.meta.url), "utf8")
    );
  await db.query("UPDATE admin_config SET config_value='false' WHERE config_key='automatic_gps_arrival'");
  // PGlite is single connection: serialize transactions. Real PG concurrency remains a separate check.
  let tail = Promise.resolve();
  const pool = {
    query: (sql, params) => db.query(sql, params),
    connect: async () => {
      const last = tail;
      let release;
      tail = new Promise((r) => (release = r));
      await last;
      return { query: (s, p) => db.query(s, p), release };
    },
  };
  const server = createApp(pool).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  async function api(method, path, body, who, expected = 200) {
    const r = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(who ? { Authorization: "Bearer " + who.token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json();
    assert.equal(r.status, expected, JSON.stringify(data));
    return data;
  }
  try {
    const register = async (role, n) => {
      const u = await api("POST", "/api/auth/register", {
        termsAccepted:true,termsVersion:'2026-10-14',user_type: role, full_name: "Test User " + n,
        phone_number: "+23760000000" + n, password: "StrongTestPassword!"
      });
      // Existing fee-workflow fixtures represent accounts that exhausted their welcome credit.
      await db.query("UPDATE connection_credit_accounts SET balance=0 WHERE user_id=$1", [u.userId]);
      if(role==='mechanic')await db.query("UPDATE users SET mechanic_review_status='approved',availability=TRUE,location_latitude=4.075,location_longitude=9.675,location_updated_at=CURRENT_TIMESTAMP WHERE id=$1",[u.userId]);
      return u;
    };
    const driver = await register("driver", 1),
      m1 = await register("mechanic", 2),
      m2 = await register("mechanic", 3),
      outsider = await register("driver", 4);
    const requestData = {
      title: "Engine failure",
      location: "Bonaberi",
      latitude: 4.075,
      longitude: 9.675,
      description: "Test request",
    };
    let request, selected;
    await t.test(
      "insufficient funds leave no request or reservation",
      async () => {
        await api("POST", "/api/repair-requests", requestData, driver, 402);
        assert.equal(
          (await db.query("SELECT COUNT(*)::int AS n FROM repair_requests"))
            .rows[0].n,
          0
        );
      }
    );
    await t.test('package validation and duplicate test receipts',async()=>{
      await api('POST','/api/wallet/topup',{amount:10000},driver,410);
      await api('POST','/api/credits/purchases/test',{packageId:'invalid',reference:'invalid_ref'},driver,400);
      for(const u of [driver,m1,m2]){
        const body={packageId:'professional',reference:'test_receipt_'+u.userId};
        await api('POST','/api/credits/purchases/test',body,u);
        await api('POST','/api/credits/purchases/test',body,u);
        assert.equal((await api('GET','/api/credits',null,u)).balance,60);
      }
    });
    await t.test(
      "driver hold at publication; mechanic hold at response",
      async () => {
        request = await api(
          "POST",
          "/api/repair-requests",
          requestData,
          driver
        );
        assert.equal(new Date(request.expires_at)-new Date(request.created_at), 2*60*60*1000);
        assert.equal(request.budget_min, null);
        assert.equal(request.budget_max, null);
        const q1 = await api(
          "POST",
          `/api/repair-requests/${request.id}/quotes`,
          { description: "Available" },
          m1
        );
        await api(
          "POST",
          `/api/repair-requests/${request.id}/quotes`,
          { description: "Available" },
          m2
        );
        for (const u of [driver, m1, m2]) {
          const w = await api("GET", "/api/wallet", null, u);
          assert.equal(w.reserved, 10);
          assert.equal(w.balance, 60);
          assert.equal(w.available, 50);
        }
        await api(
          "POST",
          `/api/repair-requests/${request.id}/quotes`,
          {},
          m1,
          409
        );
        selected = q1;
      }
    );
    await t.test(
      "ownership and selection release unselected holds",
      async () => {
        await api(
          "PATCH",
          `/api/quotes/${selected.id}/accept`,
          {},
          outsider,
          403
        );
        selected = await api(
          "PATCH",
          `/api/quotes/${selected.id}/accept`,
          {},
          driver
        );
        assert.equal((await api("GET", "/api/wallet", null, m2)).reserved, 0);
        assert.equal(
          (await api("GET", "/api/wallet", null, m1)).reserved,
          10
        );
        await api(
          "POST",
          `/api/repair-requests/${request.id}/quotes`,
          {},
          m2,
          409
        );
        const retry = await api(
          "PATCH",
          `/api/quotes/${selected.id}/accept`,
          {},
          driver
        );
        assert.equal(retry.journey.id, selected.journey.id);
      }
    );
    const j = selected.journey;
    await t.test(
      "journey access, PIN privacy and early collection denied",
      async () => {
        const records = await api("GET", "/api/journeys/active", null, m1);
        assert.equal(records[0].driver_pin_hash, undefined);
        assert.equal(records[0].driver_pin_cipher, undefined);
        await api("GET", `/api/journeys/${j.id}`, null, outsider, 403);
        await api("GET", `/api/journeys/${j.id}/pin`, null, m1, 403);
        await api(
          "POST",
          `/api/journeys/${j.id}/verify-arrival`,
          { pin: "1234" },
          m1,
          422
        );
        await api("POST", `/api/journeys/${j.id}/complete`, {}, driver, 409);
      }
    );
    await t.test("GPS rejects stale and inaccurate evidence", async () => {
      await api(
        "POST",
        `/api/journeys/${j.id}/location`,
        {
          latitude: 4.075,
          longitude: 9.675,
          accuracy: 10,
          timestamp: new Date(Date.now() - 120000).toISOString(),
        },
        m1,
        400
      );
      await api(
        "POST",
        `/api/journeys/${j.id}/location`,
        {
          latitude: 4.075,
          longitude: 9.675,
          accuracy: 100,
          timestamp: new Date().toISOString(),
        },
        m1
      );
      await api(
        "POST",
        `/api/journeys/${j.id}/verify-arrival`,
        { pin: "1234" },
        m1,
        422
      );
    });
    await db.query("DELETE FROM location_tracking WHERE journey_id=$1", [j.id]);
    // Seed historical receipts to avoid sleeping; both server receipt and GPS sample timestamps tested.
    for (const seconds of [12, 6, 0])
      await db.query(
        "INSERT INTO location_tracking(user_id,journey_id,latitude,longitude,accuracy,timestamp,sampled_at) VALUES($1,$2,4.075,9.675,10,CURRENT_TIMESTAMP-($3::int * INTERVAL '1 second'),CURRENT_TIMESTAMP-($3::int * INTERVAL '1 second'))",
        [m1.userId, j.id, seconds]
      );
    const pin = (await api("GET", `/api/journeys/${j.id}/pin`, null, driver))
      .pin;
    await t.test(
      "invalid PIN attempt persists, then both wallets debit exactly once",
      async () => {
        const invalid = await api(
          "POST",
          `/api/journeys/${j.id}/verify-arrival`,
          { pin: pin === "1111" ? "2222" : "1111" },
          m1
        );
        assert.equal(invalid.verified, false);
        assert.equal(
          (
            await db.query("SELECT pin_attempts FROM journeys WHERE id=$1", [
              j.id,
            ])
          ).rows[0].pin_attempts,
          1
        );
        await api("POST", `/api/journeys/${j.id}/verify-arrival`, { pin }, m1);
        await api("POST", `/api/journeys/${j.id}/verify-arrival`, { pin }, m1);
        for (const u of [driver, m1]) {
          const w = await api("GET", "/api/wallet", null, u);
          assert.equal(w.balance, 50);
          assert.equal(w.reserved, 0);
          assert.equal(w.available, 50);
        }
        assert.equal(
          (
            await db.query(
              "SELECT COUNT(*)::int AS n FROM connection_credit_transactions WHERE transaction_type='fee_collection'"
            )
          ).rows[0].n,
          2
        );
      }
    );
    await t.test(
      "postarrival cancellation cannot silently return collected fees",
      async () => {
        await api("POST", `/api/journeys/${j.id}/cancel`, {}, driver, 409);
        await api("POST", `/api/journeys/${j.id}/complete`, {}, driver);
      }
    );
    await t.test(
      "cancellation releases all holds; repeated cancellation harmless",
      async () => {
        const r = await api(
          "POST",
          "/api/repair-requests",
          requestData,
          driver
        );
        await api("POST", `/api/repair-requests/${r.id}/quotes`, {}, m1);
        await api("DELETE", `/api/repair-requests/${r.id}`, null, driver);
        await api("DELETE", `/api/repair-requests/${r.id}`, null, driver);
        for (const u of [driver, m1])
          assert.equal((await api("GET", "/api/wallet", null, u)).reserved, 0);
      }
    );
    await t.test("automatic request expiry releases both holds", async () => {
      const r = await api("POST", "/api/repair-requests", requestData, driver);
      await api("POST", `/api/repair-requests/${r.id}/quotes`, {}, m1);
      await db.query(
        "UPDATE repair_requests SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=$1",
        [r.id]
      );
      await expire(pool);
      await expire(pool);
      for (const u of [driver, m1])
        assert.equal((await api("GET", "/api/wallet", null, u)).reserved, 0);
    });
    await t.test(
      "selected journey timeout releases holds separately from request expiry",
      async () => {
        const r = await api(
          "POST",
          "/api/repair-requests",
          requestData,
          driver
        );
        const q = await api(
          "POST",
          `/api/repair-requests/${r.id}/quotes`,
          {},
          m1
        );
        const s = await api("PATCH", `/api/quotes/${q.id}/accept`, {}, driver);
        await db.query(
          "UPDATE journeys SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 minute' WHERE id=$1",
          [s.journey.id]
        );
        await expire(pool);
        assert.equal(
          (await api("GET", "/api/journeys/" + s.journey.id, null, driver))
            .status,
          "expired"
        );
        for (const u of [driver, m1])
          assert.equal((await api("GET", "/api/wallet", null, u)).reserved, 0);
      }
    );
    await t.test(
      "wallet operations are private and test credits cannot run outside test mode",
      async () => {
        await api(
          "POST",
          "/api/wallet/release",
          { reservationId: 1 },
          driver,
          404
        );
        process.env.ALLOW_TEST_TOPUPS = "false";
        await api(
          "POST",
          "/api/credits/purchases/test",
          { packageId:"starter",reference:"gated_receipt" },
          driver,
          403
        );
        process.env.ALLOW_TEST_TOPUPS = "true";
        await api("GET", "/api/admin/fees", null, driver, 403);
      }
    );
    await t.test(
      "simultaneous selection retries create one journey and hold",
      async () => {
        const r = await api(
          "POST",
          "/api/repair-requests",
          requestData,
          driver
        );
        const q = await api(
          "POST",
          `/api/repair-requests/${r.id}/quotes`,
          {},
          m1
        );
        const results = await Promise.all([
          api("PATCH", `/api/quotes/${q.id}/accept`, {}, driver),
          api("PATCH", `/api/quotes/${q.id}/accept`, {}, driver),
        ]);
        assert.equal(results[0].journey.id, results[1].journey.id);
        await api(
          "POST",
          `/api/journeys/${results[0].journey.id}/cancel`,
          {},
          m1
        );
      }
    );
    await t.test(
      "fee config changes preserve earlier reservations",
      async () => {
        const r = await api(
          "POST",
          "/api/repair-requests",
          requestData,
          driver
        );
        await db.query(
          "UPDATE admin_config SET config_value='1500' WHERE config_key='connection_fee_driver'"
        );
        const held = (
          await db.query(
            "SELECT amount FROM connection_credit_reservations WHERE repair_request_id=$1 AND user_id=$2 AND status='reserved'",
            [r.id, driver.userId]
          )
        ).rows[0];
        assert.equal(held.amount, 10);
        await api("DELETE", `/api/repair-requests/${r.id}`, null, driver);
        await db.query(
          "UPDATE admin_config SET config_value='1000' WHERE config_key='connection_fee_driver'"
        );
      }
    );
    await t.test(
      "mechanic cannot respond without available funds",
      async () => {
        const broke = await register("mechanic", 5);
        const r = await api(
          "POST",
          "/api/repair-requests",
          requestData,
          driver
        );
        await api(
          "POST",
          `/api/repair-requests/${r.id}/quotes`,
          {},
          broke,
          402
        );
        assert.equal(
          (
            await db.query(
              "SELECT COUNT(*)::int AS n FROM quotes WHERE mechanic_id=$1",
              [broke.userId]
            )
          ).rows[0].n,
          0
        );
        await api("DELETE", `/api/repair-requests/${r.id}`, null, driver);
      }
    );
    await t.test(
      "withdrawal releases hold and allows another response",
      async () => {
        const r = await api(
          "POST",
          "/api/repair-requests",
          requestData,
          driver
        );
        const q = await api(
          "POST",
          `/api/repair-requests/${r.id}/quotes`,
          {},
          m1
        );
        await api("DELETE", `/api/quotes/${q.id}`, null, m1);
        await api("DELETE", `/api/quotes/${q.id}`, null, m1);
        assert.equal((await api("GET", "/api/wallet", null, m1)).reserved, 0);
        await api("POST", `/api/repair-requests/${r.id}/quotes`, {}, m1);
        await api("DELETE", `/api/repair-requests/${r.id}`, null, driver);
      }
    );
    await t.test(
      "admin refunds once to wallet and revenue excludes deposits/releases",
      async () => {
        await db.query("UPDATE users SET is_admin=TRUE WHERE id=$1", [
          outsider.userId,
        ]);
        const txId = (
          await db.query(
            "SELECT id FROM connection_credit_transactions WHERE user_id=$1 AND transaction_type='fee_collection'",
            [driver.userId]
          )
        ).rows[0].id;
        assert.equal(
          (await api("GET", "/api/admin/analytics/dashboard", null, outsider))
            .totalCreditsUsed,
          20
        );
        await api(
          "POST",
          "/api/admin/refunds",
          { transactionId: txId, reason: "Support approved" },
          outsider
        );
        await api(
          "POST",
          "/api/admin/refunds",
          { transactionId: txId, reason: "Retry" },
          outsider
        );
        assert.equal(
          (await api("GET", "/api/wallet", null, driver)).balance,
          60
        );
        assert.equal(
          (await api("GET", "/api/admin/analytics/dashboard", null, outsider))
            .totalCreditsUsed,
          10
        );
      }
    );
    await t.test('20 signup credits once, no money-wallet conversion',async()=>{
      const d=await api('POST','/api/auth/register',{termsAccepted:true,termsVersion:'2026-10-14',user_type:'driver',full_name:'Welcome Driver',phone_number:'600000006',password:'StrongTestPassword!'});
      assert.equal((await api('GET','/api/credits',null,d)).balance,20);
      assert.equal(await grantWelcomeCredit(pool,d.userId),false);
      await api('POST','/api/auth/login',{phone_number:'600000006',password:'StrongTestPassword!'});
      assert.equal((await api('GET','/api/credits',null,d)).balance,20);
      assert.equal((await db.query('SELECT balance FROM wallets WHERE user_id=$1',[d.userId])).rows[0].balance,0);
    });
    await t.test("automatic GPS arrival collects once without PIN and rejects premature/unauthorized arrival", async () => {
      await db.query("UPDATE admin_config SET config_value='true' WHERE config_key='automatic_gps_arrival'");
      await db.query("UPDATE admin_config SET config_value='1000' WHERE config_key IN ('connection_fee_driver','connection_fee_mechanic')");
      const d=await register('driver',9), m=await register('mechanic',0);
      for (const u of [d,m]) await api('POST','/api/credits/purchases/test',{packageId:'professional',reference:'auto_receipt_'+u.userId},u);
      const r=await api('POST','/api/repair-requests',requestData,d);
      const q=await api('POST',`/api/repair-requests/${r.id}/quotes`,{},m);
      const j=(await api('PATCH',`/api/quotes/${q.id}/accept`,{},d)).journey;
      const sample={latitude:4.075,longitude:9.675,accuracy:10,timestamp:new Date().toISOString()};
      await api('POST',`/api/journeys/${j.id}/location`,sample,d,403);
      const early=await api('POST',`/api/journeys/${j.id}/location`,sample,m);
      assert.equal(early.verified,false);
      assert.equal((await api('GET','/api/wallet',null,d)).balance,60);
      await db.query('DELETE FROM location_tracking WHERE journey_id=$1',[j.id]);
      for(const seconds of [12,6]) await db.query("INSERT INTO location_tracking(user_id,journey_id,latitude,longitude,accuracy,timestamp,sampled_at) VALUES($1,$2,4.075,9.675,10,CURRENT_TIMESTAMP-($3::int*INTERVAL '1 second'),CURRENT_TIMESTAMP-($3::int*INTERVAL '1 second'))",[m.userId,j.id,seconds]);
      const arrived=await api('POST',`/api/journeys/${j.id}/location`,{...sample,timestamp:new Date().toISOString()},m);
      assert.equal(arrived.verified,true);
      assert.equal((await api('GET',`/api/journeys/${j.id}`,null,d)).status,'both_arrived');
      for(const u of [d,m]) assert.equal((await api('GET','/api/wallet',null,u)).balance,50);
      await api('POST',`/api/journeys/${j.id}/location`,{...sample,timestamp:new Date().toISOString()},m,409);
      for(const u of [d,m]) assert.equal((await api('GET','/api/wallet',null,u)).balance,50);
    });
  } finally {
    await new Promise((r) => server.close(r));
    await db.close();
  }
});
