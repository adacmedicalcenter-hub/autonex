import { grantWelcomeCredit } from './services/feeService.js';
import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import {
  WorkflowError,
  amount,
  getFeeConfig,
  releaseFee,
} from "./services/feeService.js";
import {
  transaction,
  createRequest,
  respond,
  select,
  journey,
  cancelRequest,
  cancelJourney,
  reportLocation,
  verifyArrival,
  revealPin,
  refreshPin,
  distance,
  coordinates,
  publicJourney,
} from "./services/workflowService.js";
export function createApp(pool) {
  const app = express();
  app.use(cors());
  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));
  const route = (method, path, fn, ...middleware) =>
    app[method](path, ...middleware, async (req, res, next) => {
      try {
        res.json(await fn(req, res));
      } catch (e) {
        next(e);
      }
    });
  const tx = (fn) => transaction(pool, fn);
  async function auth(req, res, next) {
    try {
      const t = req.headers.authorization?.replace(/^Bearer /, "");
      if (!t) throw new WorkflowError("Login required", 401);
      const u = jwt.verify(t, process.env.JWT_SECRET);
      req.user = (
        await pool.query(
          "SELECT id,user_type,is_admin,suspended,suspend_until FROM users WHERE id=$1",
          [u.userId]
        )
      ).rows[0];
      if (!req.user) throw new WorkflowError("Login required", 401);
      if (
        req.user.suspended &&
        (!req.user.suspend_until ||
          new Date(req.user.suspend_until) > new Date())
      )
        throw new WorkflowError("Account suspended", 403);
      next();
    } catch (e) {
      next(
        e instanceof WorkflowError
          ? e
          : new WorkflowError("Invalid login token", 401)
      );
    }
  }
  const role = (type) => (req, res, next) =>
    req.user.user_type === type
      ? next()
      : next(new WorkflowError(`${type} access required`, 403));
  const admin = (req, res, next) =>
    req.user.is_admin
      ? next()
      : next(new WorkflowError("Admin access required", 403));
  const token = (u) => ({
    token: jwt.sign(
      { userId: u.id, userType: u.user_type },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    ),
    userId: u.id,
    userType: u.user_type,
    fullName: u.full_name,
    isAdmin: u.is_admin || false,
  });
  route("get", "/health", async () => ({
    status: "ok",
    environment: process.env.APP_ENV,
  }));
  route("post", "/api/auth/register", async (req) => {
    const { user_type, full_name, phone_number, password } = req.body;
    if (
      !["driver", "mechanic"].includes(user_type) ||
      !String(full_name || "").trim() ||
      !/^\+237[26]\d{8}$/.test(phone_number) ||
      typeof password !== "string" ||
      password.length < 8
    )
      throw new WorkflowError(
        "Use a valid Cameroon phone number (+237…), name, role and password of at least 8 characters",
        400
      );
    return tx(async (c) => {
      const u = (
        await c.query(
          "INSERT INTO users(user_type,full_name,phone_number,password_hash) VALUES($1,$2,$3,$4) RETURNING *",
          [user_type, full_name, phone_number, await bcrypt.hash(password, 10)]
        )
      ).rows[0];
      await c.query("INSERT INTO wallets(user_id) VALUES($1)", [u.id]);
      await grantWelcomeCredit(c, u.id);
      return token(u);
    });
  });
  route("post", "/api/auth/login", async (req) => {
    const u = (
      await pool.query("SELECT * FROM users WHERE phone_number=$1", [
        req.body.phone_number,
      ])
    ).rows[0];
    if (
      !u ||
      !(await bcrypt.compare(String(req.body.password || ""), u.password_hash))
    )
      throw new WorkflowError("Invalid credentials", 401);
    if (
      u.suspended &&
      (!u.suspend_until || new Date(u.suspend_until) > new Date())
    )
      throw new WorkflowError("Account suspended", 403);
    return token(u);
  });
  route(
    "get",
    "/api/wallet",
    async (req) => ({ ...( 
        await pool.query(
          "SELECT *,balance-reserved AS available FROM wallets WHERE user_id=$1",
          [req.user.id]
        )
      ).rows[0], welcomeCreditGranted: true, welcomeCreditAmount: 10000 }),
    auth
  );
  route(
    "get",
    "/api/wallet/transactions",
    async (req) =>
      (
        await pool.query(
          "SELECT * FROM wallet_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 100",
          [req.user.id]
        )
      ).rows,
    auth
  );
  route(
    "post",
    "/api/wallet/topup",
    async (req) => {
      if (
        process.env.APP_ENV !== "test" ||
        process.env.ALLOW_TEST_TOPUPS !== "true"
      )
        throw new WorkflowError(
          "Test top-ups are disabled. Provider payments are not configured.",
          403
        );
      if (req.body.nonwithdrawableAcknowledged !== true)
        throw new WorkflowError(
          "Acknowledge nonwithdrawable wallet credit before top-up",
          400
        );
      const value = amount(req.body.amount);
      const reference = req.body.transactionId || randomUUID();
      if (typeof reference !== "string" || reference.length > 150)
        throw new WorkflowError("Invalid payment reference", 400);
      return tx(async (c) => {
        const w = (
          await c.query("SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE", [
            req.user.id,
          ])
        ).rows[0];
        const old = (
          await c.query("SELECT * FROM payment_receipts WHERE reference=$1", [
            reference,
          ])
        ).rows[0];
        if (old) {
          if (old.user_id !== req.user.id || old.amount !== value)
            throw new WorkflowError("Reference already used");
          return { wallet: w, simulated: true, duplicate: true };
        }
        await c.query(
          "INSERT INTO payment_receipts(reference,user_id,amount,provider) VALUES($1,$2,$3,'test_deposit')",
          [reference, req.user.id, value]
        );
        const updated = (
          await c.query(
            "UPDATE wallets SET balance=balance+$1 WHERE user_id=$2 RETURNING *",
            [value, req.user.id]
          )
        ).rows[0];
        await c.query(
          "INSERT INTO wallet_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description) VALUES($1,'topup',$2,$3,$4,'test_deposit',$5,'SIMULATED credit: no Mobile Money payment')",
          [req.user.id, value, w.balance, updated.balance, reference]
        );
        return { wallet: updated, simulated: true };
      });
    },
    auth
  );
  // No public reserve/release/collect endpoints. State transitions own these operations.
  route(
    "post",
    "/api/repair-requests",
    (req) => tx((c) => createRequest(c, req.user.id, req.body)),
    auth,
    role("driver")
  );
  route(
    "get",
    "/api/repair-requests",
    async (req) => {
      const own = req.user.user_type === "driver";
      return (
        await pool.query(
          "SELECT r.*,u.full_name AS driver_name FROM repair_requests r JOIN users u ON u.id=r.driver_id WHERE ($1::boolean AND r.driver_id=$2) OR (NOT $1::boolean AND r.status='open' AND r.expires_at>CURRENT_TIMESTAMP) ORDER BY r.created_at DESC LIMIT 100",
          [own, req.user.id]
        )
      ).rows;
    },
    auth
  );
  route(
    "get",
    "/api/repair-requests/:id",
    async (req) => {
      const r = (
        await pool.query("SELECT * FROM repair_requests WHERE id=$1", [
          req.params.id,
        ])
      ).rows[0];
      if (!r) throw new WorkflowError("Request not found", 404);
      if (req.user.user_type === "driver" && r.driver_id !== req.user.id)
        throw new WorkflowError("Request access denied", 403);
      const qs = (
        await pool.query(
          "SELECT q.*,u.full_name AS mechanic_name FROM quotes q JOIN users u ON u.id=q.mechanic_id WHERE repair_request_id=$1 AND ($2::boolean OR mechanic_id=$3)",
          [r.id, r.driver_id === req.user.id, req.user.id]
        )
      ).rows;
      return { ...r, quotes: qs };
    },
    auth
  );
  route(
    "delete",
    "/api/repair-requests/:id",
    (req) => tx((c) => cancelRequest(c, req.user.id, req.params.id)),
    auth,
    role("driver")
  );
  route(
    "post",
    "/api/repair-requests/:id/quotes",
    (req) => tx((c) => respond(c, req.user.id, req.params.id, req.body)),
    auth,
    role("mechanic")
  );
  route(
    "post",
    "/api/quotes",
    (req) =>
      tx((c) => respond(c, req.user.id, req.body.repair_request_id, req.body)),
    auth,
    role("mechanic")
  );
  route(
    "patch",
    "/api/quotes/:id/accept",
    (req) => tx((c) => select(c, req.user.id, req.params.id)),
    auth,
    role("driver")
  );
  route(
    "delete",
    "/api/quotes/:id",
    (req) =>
      tx(async (c) => {
        const q = (
          await c.query("SELECT * FROM quotes WHERE id=$1", [req.params.id])
        ).rows[0];
        if (!q || q.mechanic_id !== req.user.id)
          throw new WorkflowError("Response access denied", 403);
        await c.query("SELECT id FROM repair_requests WHERE id=$1 FOR UPDATE", [
          q.repair_request_id,
        ]);
        const current = (
          await c.query("SELECT * FROM quotes WHERE id=$1 FOR UPDATE", [q.id])
        ).rows[0];
        if (current.status === "accepted")
          throw new WorkflowError("Use journey cancellation after selection");
        const rs = (
          await c.query(
            "SELECT id FROM reservations WHERE repair_request_id=$1 AND user_id=$2 AND status='reserved'",
            [q.repair_request_id, req.user.id]
          )
        ).rows;
        for (const r of rs) await releaseFee(r.id, "Response withdrawn", c);
        await c.query("UPDATE quotes SET status='rejected' WHERE id=$1", [
          q.id,
        ]);
        return { withdrawn: true };
      }),
    auth,
    role("mechanic")
  );
  route(
    "get",
    "/api/journeys/active",
    async (req) =>
      (
        await pool.query(
          "SELECT j.*,d.full_name AS driver_name,m.full_name AS mechanic_name FROM journeys j JOIN users d ON d.id=j.driver_id JOIN users m ON m.id=j.mechanic_id WHERE (j.driver_id=$1 OR j.mechanic_id=$1) AND j.status IN ('active','both_arrived') ORDER BY j.id DESC",
          [req.user.id]
        )
      ).rows.map(publicJourney),
    auth
  );
  // Compatibility: selection already creates a journey; never reserve twice.
  route(
    "post",
    "/api/journeys",
    (req) =>
      tx(async (c) => {
        const j = (
          await c.query("SELECT id FROM journeys WHERE repair_request_id=$1", [
            req.body.repairRequestId,
          ])
        ).rows[0];
        if (!j) throw new WorkflowError("Select a mechanic response first");
        return { journey: publicJourney(await journey(c, j.id, req.user.id)) };
      }),
    auth,
    role("driver")
  );
  route(
    "get",
    "/api/journeys/:id",
    (req) =>
      tx(async (c) => {
        const j = await journey(c, req.params.id, req.user.id);
        const safe = publicJourney(j);
        return {
          ...safe,
          repair_request: {
            latitude: Number(j.destination_latitude),
            longitude: Number(j.destination_longitude),
          },
        };
      }),
    auth
  );
  route(
    "get",
    "/api/journeys/:id/pin",
    (req) =>
      tx(async (c) => {
        const j = await journey(c, req.params.id, req.user.id);
        if (j.driver_id !== req.user.id)
          throw new WorkflowError(
            "Only the driver can view the arrival PIN",
            403
          );
        if (
          j.status !== "active" ||
          new Date(j.driver_pin_expires_at) <= new Date()
        )
          throw new WorkflowError("Refresh the PIN before arrival", 422);
        return { pin: revealPin(j), expiresAt: j.driver_pin_expires_at };
      }),
    auth
  );
  route(
    "post",
    "/api/journeys/:id/pin/refresh",
    (req) => tx((c) => refreshPin(c, req.user.id, req.params.id)),
    auth,
    role("driver")
  );
  route(
    "post",
    "/api/journeys/:id/location",
    (req) => tx((c) => reportLocation(c, req.user.id, req.params.id, req.body)),
    auth,
    role("mechanic")
  );
  route(
    "post",
    "/api/journeys/:id/verify-arrival",
    (req) =>
      tx((c) => verifyArrival(c, req.user.id, req.params.id, req.body.pin)),
    auth,
    role("mechanic")
  );
  route(
    "post",
    "/api/journeys/:id/cancel",
    (req) =>
      tx((c) => cancelJourney(c, req.user.id, req.params.id, req.body.reason)),
    auth
  );
  route(
    "post",
    "/api/journeys/:id/complete",
    (req) =>
      tx(async (c) => {
        const j = await journey(c, req.params.id, req.user.id);
        if (!j.both_fees_collected)
          throw new WorkflowError(
            "Verified arrival required before completion"
          );
        await c.query(
          "UPDATE journeys SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=$1",
          [j.id]
        );
        await c.query(
          "UPDATE repair_requests SET status='completed' WHERE id=$1",
          [j.repair_request_id]
        );
        return { completed: true };
      }),
    auth
  );
  route(
    "get",
    "/api/users/profile",
    async (req) =>
      (
        await pool.query(
          "SELECT id,full_name,phone_number,user_type,availability,locality,specialization,location_latitude,location_longitude FROM users WHERE id=$1",
          [req.user.id]
        )
      ).rows[0],
    auth
  );
  route(
    "patch",
    "/api/users/profile",
    async (req) => {
      if (req.body.latitude != null) coordinates(req.body);
      return (
        await pool.query(
          "UPDATE users SET availability=COALESCE($1,availability),locality=COALESCE($2,locality),specialization=COALESCE($3,specialization),location_latitude=COALESCE($4,location_latitude),location_longitude=COALESCE($5,location_longitude),location_updated_at=CASE WHEN $4::numeric IS NULL THEN location_updated_at ELSE CURRENT_TIMESTAMP END WHERE id=$6 RETURNING id,availability,locality,specialization",
          [
            req.body.availability ?? null,
            req.body.locality ?? null,
            req.body.specialization ?? null,
            req.body.latitude ?? null,
            req.body.longitude ?? null,
            req.user.id,
          ]
        )
      ).rows[0];
    },
    auth
  );
  route(
    "get",
    "/api/users/:id",
    async (req) =>
      (
        await pool.query(
          "SELECT id,full_name,user_type,locality,specialization FROM users WHERE id=$1",
          [req.params.id]
        )
      ).rows[0],
    auth
  );
  route(
    "get",
    "/api/mechanics/available",
    async (req) => {
      const lat = Number(req.query.latitude),
        lon = Number(req.query.longitude);
      coordinates({ latitude: lat, longitude: lon });
      let rows = (
        await pool.query(
          "SELECT id,full_name,locality,specialization,location_latitude,location_longitude,location_updated_at FROM users WHERE user_type='mechanic' AND availability=TRUE AND NOT suspended AND location_updated_at>CURRENT_TIMESTAMP-INTERVAL '5 minutes' AND location_latitude IS NOT NULL LIMIT 500"
        )
      ).rows;
      rows = rows
        .filter(
          (r) =>
            !req.query.specialization ||
            r.specialization === req.query.specialization
        )
        .map((r) => ({
          ...r,
          distance_m: distance(
            { latitude: lat, longitude: lon },
            { latitude: r.location_latitude, longitude: r.location_longitude }
          ),
          local_priority: Boolean(
            req.query.locality &&
              r.locality?.toLowerCase() === req.query.locality.toLowerCase()
          ),
        }));
      return rows.sort(
        (a, b) =>
          Number(b.local_priority) - Number(a.local_priority) ||
          a.distance_m - b.distance_m
      );
    },
    auth
  );
  route(
    "get",
    "/api/service-offers",
    async (req) =>
      (
        await pool.query(
          "SELECT s.*,u.full_name AS mechanic_name FROM service_offers s JOIN users u ON u.id=s.mechanic_id WHERE s.is_active=TRUE ORDER BY s.id DESC LIMIT 100"
        )
      ).rows,
    auth
  );
  route(
    "post",
    "/api/service-offers",
    async (req) =>
      (
        await pool.query(
          "INSERT INTO service_offers(mechanic_id,service_name,description,specialization,hourly_rate,location) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            req.user.id,
            req.body.service_name,
            req.body.description,
            req.body.specialization,
            null,
            req.body.location,
          ]
        )
      ).rows[0],
    auth,
    role("mechanic")
  );
  route(
    "delete",
    "/api/service-offers/:id",
    async (req) => {
      await pool.query(
        "UPDATE service_offers SET is_active=FALSE WHERE id=$1 AND mechanic_id=$2",
        [req.params.id, req.user.id]
      );
      return { deleted: true };
    },
    auth,
    role("mechanic")
  );
  route(
    "patch",
    "/api/service-offers/:id",
    async (req) =>
      (
        await pool.query(
          "UPDATE service_offers SET service_name=COALESCE($1,service_name),description=COALESCE($2,description),hourly_rate=$3 WHERE id=$4 AND mechanic_id=$5 RETURNING *",
          [
            req.body.service_name ?? null,
            req.body.description ?? null,
            null,
            req.params.id,
            req.user.id,
          ]
        )
      ).rows[0],
    auth,
    role("mechanic")
  );
  route(
    "post",
    "/api/conversations",
    async (req) => {
      const other = (
        await pool.query("SELECT * FROM users WHERE id=$1", [
          req.body.other_user_id,
        ])
      ).rows[0];
      if (!other || other.user_type === req.user.user_type)
        throw new WorkflowError("Choose a driver and mechanic", 400);
      const driver = req.user.user_type === "driver" ? req.user.id : other.id,
        mechanic = req.user.user_type === "mechanic" ? req.user.id : other.id;
      return (
        await pool.query(
          "INSERT INTO conversations(driver_id,mechanic_id) VALUES($1,$2) ON CONFLICT(driver_id,mechanic_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP RETURNING *",
          [driver, mechanic]
        )
      ).rows[0];
    },
    auth
  );
  route(
    "get",
    "/api/conversations",
    async (req) =>
      (
        await pool.query(
          "SELECT c.*,d.full_name AS driver_name,m.full_name AS mechanic_name FROM conversations c JOIN users d ON d.id=c.driver_id JOIN users m ON m.id=c.mechanic_id WHERE c.driver_id=$1 OR c.mechanic_id=$1 ORDER BY c.updated_at DESC",
          [req.user.id]
        )
      ).rows,
    auth
  );
  async function conversation(id, user) {
    const c = (
      await pool.query(
        "SELECT * FROM conversations WHERE id=$1 AND (driver_id=$2 OR mechanic_id=$2)",
        [id, user]
      )
    ).rows[0];
    if (!c) throw new WorkflowError("Conversation access denied", 403);
    return c;
  }
  route(
    "get",
    "/api/conversations/:id/messages",
    async (req) => {
      await conversation(req.params.id, req.user.id);
      return (
        await pool.query(
          "SELECT m.*,u.full_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE conversation_id=$1 ORDER BY m.id DESC LIMIT 100",
          [req.params.id]
        )
      ).rows.reverse();
    },
    auth
  );
  route(
    "post",
    "/api/conversations/:id/messages",
    async (req) => {
      await conversation(req.params.id, req.user.id);
      if (!String(req.body.message_text || "").trim())
        throw new WorkflowError("Message is empty", 400);
      return (
        await pool.query(
          "INSERT INTO messages(conversation_id,sender_id,sender_type,message_text) VALUES($1,$2,$3,$4) RETURNING *",
          [
            req.params.id,
            req.user.id,
            req.user.user_type,
            req.body.message_text,
          ]
        )
      ).rows[0];
    },
    auth
  );
  route(
    "get",
    "/api/admin/analytics/dashboard",
    async () => {
      const users = (await pool.query("SELECT COUNT(*)::int AS n FROM users"))
        .rows[0].n;
      const journeys = (
        await pool.query(
          "SELECT COUNT(*)::int AS n,COUNT(*) FILTER(WHERE status='completed')::int AS completed FROM journeys"
        )
      ).rows[0];
      const revenue = (
        await pool.query(
          "SELECT COALESCE(-SUM(amount),0)::int AS n FROM wallet_transactions WHERE transaction_type IN ('fee_collection','refund')"
        )
      ).rows[0].n;
      return {
        totalUsers: users,
        totalJourneys: journeys.n,
        completedJourneys: journeys.completed,
        totalRevenue: revenue,
        activeRequests: (
          await pool.query(
            "SELECT COUNT(*)::int AS n FROM repair_requests WHERE status='open'"
          )
        ).rows[0].n,
      };
    },
    auth,
    admin
  );
  route(
    "get",
    "/api/admin/users",
    async (req) => ({
      users: (
        await pool.query(
          "SELECT id,full_name,phone_number,user_type,is_admin,suspended,created_at FROM users WHERE full_name ILIKE $1 ORDER BY id DESC LIMIT 100",
          ["%" + (req.query.search || "") + "%"]
        )
      ).rows,
    }),
    auth,
    admin
  );
  route(
    "post",
    "/api/admin/users/:id/suspend",
    (req) =>
      tx(async (c) => {
        if (Number(req.params.id) === req.user.id)
          throw new WorkflowError("Cannot suspend own admin account");
        await c.query(
          "UPDATE users SET suspended=TRUE,suspend_reason=$1 WHERE id=$2",
          [req.body.reason || "Admin suspension", req.params.id]
        );
        await c.query(
          "INSERT INTO admin_audit(admin_id,action,details) VALUES($1,'suspend',$2)",
          [
            req.user.id,
            JSON.stringify({ userId: req.params.id, reason: req.body.reason }),
          ]
        );
        return { suspended: true };
      }),
    auth,
    admin
  );
  route("get", "/api/admin/fees", async () => getFeeConfig(pool), auth, admin);
  route(
    "patch",
    "/api/admin/fees",
    (req) =>
      tx(async (c) => {
        const driverFee = amount(req.body.driverFee),
          mechanicFee = amount(req.body.mechanicFee);
        await c.query(
          "UPDATE admin_config SET config_value=CASE config_key WHEN 'connection_fee_driver' THEN $1 ELSE $2 END WHERE config_key IN ('connection_fee_driver','connection_fee_mechanic')",
          [String(driverFee), String(mechanicFee)]
        );
        await c.query(
          "INSERT INTO admin_audit(admin_id,action,details) VALUES($1,'fees',$2)",
          [req.user.id, JSON.stringify({ driverFee, mechanicFee })]
        );
        return { driverFee, mechanicFee, environment: "TEST" };
      }),
    auth,
    admin
  );
  route(
    "get",
    "/api/admin/requests",
    async (req) =>
      (
        await pool.query(
          "SELECT * FROM repair_requests ORDER BY id DESC LIMIT 100"
        )
      ).rows,
    auth,
    admin
  );
  route(
    "get",
    "/api/admin/journeys",
    async (req) =>
      (
        await pool.query(
          "SELECT id,repair_request_id,driver_id,mechanic_id,status,both_fees_collected,created_at FROM journeys ORDER BY id DESC LIMIT 100"
        )
      ).rows,
    auth,
    admin
  );
  route(
    "get",
    "/api/admin/transactions",
    async (req) =>
      (
        await pool.query(
          "SELECT * FROM wallet_transactions ORDER BY id DESC LIMIT 100"
        )
      ).rows,
    auth,
    admin
  );
  // Refunds restore wallet credit only; no transfer to Mobile Money. One refund per collection.
  route(
    "post",
    "/api/admin/refunds",
    (req) =>
      tx(async (c) => {
        if (!String(req.body.reason || "").trim())
          throw new WorkflowError("Refund reason required", 400);
        const t = (
          await c.query(
            "SELECT * FROM wallet_transactions WHERE id=$1 AND transaction_type='fee_collection' FOR UPDATE",
            [req.body.transactionId]
          )
        ).rows[0];
        if (!t) throw new WorkflowError("Fee collection not found", 404);
        const ref = "refund_" + t.id;
        if (
          (
            await c.query(
              "SELECT id FROM wallet_transactions WHERE transaction_type='refund' AND reference_id=$1",
              [ref]
            )
          ).rows.length
        )
          return { alreadyRefunded: true };
        const w = (
          await c.query("SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE", [
            t.user_id,
          ])
        ).rows[0];
        await c.query(
          "UPDATE wallets SET balance=balance+$1 WHERE user_id=$2",
          [-t.amount, t.user_id]
        );
        await c.query(
          "INSERT INTO wallet_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description) VALUES($1,'refund',$2,$3,$4,'fee_refund',$5,$6)",
          [
            t.user_id,
            -t.amount,
            w.balance,
            w.balance - t.amount,
            ref,
            req.body.reason,
          ]
        );
        await c.query(
          "INSERT INTO admin_audit(admin_id,action,details) VALUES($1,'refund',$2)",
          [req.user.id, JSON.stringify(req.body)]
        );
        return { refunded: true };
      }),
    auth,
    admin
  );
  app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));
  app.use((e, req, res, next) => {
    const status = e.status || (e.code === "23505" ? 409 : 500);
    if (status === 500) console.error("API error", e.message);
    res
      .status(status)
      .json({ error: status === 500 ? "Server operation failed" : e.message });
  });
  return app;
}
