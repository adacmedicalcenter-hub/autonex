import {audioNote} from './services/audioService.js';
import {protect,reveal,validateProfile,requireApproved,chatJourney,requestAudience} from './services/profileService.js';
import {reconcileRequestAlerts} from './services/pushService.js';
import { queueRequestAlerts } from './services/pushService.js';
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
export function createApp(pool, { pushEnabled = false } = {}) {
  const app = express();
  app.use(cors());
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
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
          "SELECT id,user_type,is_admin,suspended,suspend_until,mechanic_review_status FROM users WHERE id=$1",
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
  const approved = async (req,res,next)=>{try {await requireApproved(pool,req.user.id);next();}catch(e){next(e);}};
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
  const installation = req => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.body.installationId || ''))
      throw new WorkflowError('Invalid phone installation ID',400);
    return req.body.installationId;
  };
  route('post','/api/notifications/device', async req => {
    const id=installation(req), token=req.body.token;
    if (typeof token!=='string' || token.length<20 || token.length>4096 || /\s/.test(token))
      throw new WorkflowError('Invalid notification token',400);
    await tx(async c => {
      await c.query('DELETE FROM push_devices WHERE token=$1 AND installation_id<>$2',[token,id]);
      await c.query(`INSERT INTO push_devices(installation_id,user_id,token) VALUES($1,$2,$3)
        ON CONFLICT(installation_id) DO UPDATE SET user_id=EXCLUDED.user_id,token=EXCLUDED.token,updated_at=CURRENT_TIMESTAMP`,[id,req.user.id,token]);
    });
    await reconcileRequestAlerts(pool,req.user.id);
    return {registered:true,pushEnabled};
  },auth);
  route('delete','/api/notifications/device',async req => {
    await pool.query('DELETE FROM push_devices WHERE installation_id=$1 AND user_id=$2',[installation(req),req.user.id]);
    return {removed:true};
  },auth);
  route('get','/api/notifications/status',async req => ({pushEnabled,
    eligibility:(await pool.query("SELECT availability,mechanic_review_status,location_updated_at,EXISTS(SELECT 1 FROM push_devices d WHERE d.user_id=users.id) AS phone_registered FROM users WHERE id=$1",[req.user.id])).rows[0],
    lastRequest:(await pool.query("SELECT repair_request_id,status,attempts,last_error,sent_at FROM push_outbox WHERE user_id=$1 AND kind='request' ORDER BY id DESC LIMIT 1",[req.user.id])).rows[0]||null,
    devices:Number((await pool.query('SELECT COUNT(*) AS n FROM push_devices WHERE user_id=$1',[req.user.id])).rows[0].n),
    lastTest:(await pool.query("SELECT status,attempts,last_error,sent_at FROM push_outbox WHERE user_id=$1 AND kind='test' ORDER BY id DESC LIMIT 1",[req.user.id])).rows[0]||null}),auth);
  route('post','/api/notifications/test',async req => {
    if (!pushEnabled) throw new WorkflowError('Firebase sending is not configured on this backend',503);
    return tx(async c => {
      // Database bucket limits each account to one test per minute across its phones.
      const devices=(await c.query('SELECT installation_id FROM push_devices WHERE user_id=$1',[req.user.id])).rows;
      if (!devices.length) throw new WorkflowError('Enable notifications on this phone first',400);
      const key='test_'+req.user.id+'_'+Math.floor(Date.now()/60000);
      for (const d of devices) await c.query(`INSERT INTO push_outbox(event_key,user_id,installation_id,kind,expires_at)
        VALUES($1,$2,$3,'test',CURRENT_TIMESTAMP+INTERVAL '5 minutes') ON CONFLICT DO NOTHING`,[key,req.user.id,d.installation_id]);
      return {queued:true};
    });
  },auth);
  route(
    "get",
    "/api/wallet",
    async (req) => ({ ...( 
        await pool.query(
          "SELECT *,balance-reserved AS available FROM wallets WHERE user_id=$1",
          [req.user.id]
        )
      ).rows[0], welcomeCreditGranted: true, welcomeCreditAmount: Number((await pool.query("SELECT amount FROM welcome_credit_grants WHERE user_id=$1",[req.user.id])).rows[0]?.amount || 0), newAccountWelcomeCreditAmount: 2000 }),
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
    (req) => tx(async c => {
      const request = await createRequest(c, req.user.id, req.body);
      const notificationsQueued = await queueRequestAlerts(c, request);
      return {...request, notificationsQueued};
    }),
    auth,
    role("driver")
  );
  route(
    "get",
    "/api/repair-requests",
    async (req) => {
      if(req.user.user_type==='mechanic') await requireApproved(pool,req.user.id);
      const own = req.user.user_type === "driver";
      const rows = (
        await pool.query(
          "SELECT r.id,r.driver_id,r.title,r.description,r.vehicle_type,r.location,r.latitude,r.longitude,r.status,r.created_at,r.expires_at,(r.audio_note IS NOT NULL) AS has_audio,u.full_name AS driver_name FROM repair_requests r JOIN users u ON u.id=r.driver_id WHERE ($1::boolean AND r.driver_id=$2) OR (NOT $1::boolean AND r.status='open' AND r.expires_at>CURRENT_TIMESTAMP) ORDER BY r.created_at DESC LIMIT 100",
          [own, req.user.id]
        )
      ).rows;
      if(own)return rows;
      const u=(await pool.query('SELECT availability,location_latitude,location_longitude,location_updated_at,is_active FROM users WHERE id=$1',[req.user.id])).rows[0];
      if(!u.availability||!u.is_active||u.location_latitude==null||u.location_longitude==null||!u.location_updated_at||Date.now()-new Date(u.location_updated_at).getTime()>86400000)return [];
      return rows.filter(r=>distance(r,{latitude:u.location_latitude,longitude:u.location_longitude})<=5000);
    },
    auth
  );
  route(
    "get",
    "/api/repair-requests/:id",
    async (req) => {
      if(req.user.user_type==='mechanic') await requireApproved(pool,req.user.id);
      const r = (
        await pool.query("SELECT * FROM repair_requests WHERE id=$1", [
          req.params.id,
        ])
      ).rows[0];
      if (!r) throw new WorkflowError("Request not found", 404);
      if(req.user.user_type==='mechanic')await requestAudience(pool,req.user.id,r);
      if (req.user.user_type === "driver" && r.driver_id !== req.user.id)
        throw new WorkflowError("Request access denied", 403);
      const qs = (
        await pool.query(
          "SELECT q.id,q.repair_request_id,q.mechanic_id,q.quoted_price,q.estimated_time,q.description,q.status,q.created_at,(q.audio_note IS NOT NULL) AS has_audio,u.full_name AS mechanic_name FROM quotes q JOIN users u ON u.id=q.mechanic_id WHERE repair_request_id=$1 AND ($2::boolean OR mechanic_id=$3)",
          [r.id, r.driver_id === req.user.id, req.user.id]
        )
      ).rows;
      const {audio_note,...publicRequest}=r;
      return { ...publicRequest,has_audio:Boolean(audio_note), quotes: qs };
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
    role("mechanic"),
    approved
  );
  route(
    "post",
    "/api/quotes",
    (req) =>
      tx((c) => respond(c, req.user.id, req.body.repair_request_id, req.body)),
    auth,
    role("mechanic"),
    approved
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
    role("mechanic"),
    approved
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
    role("mechanic"),
    approved
  );
  route(
    "post",
    "/api/journeys/:id/verify-arrival",
    (req) =>
      tx((c) => verifyArrival(c, req.user.id, req.params.id, req.body.pin)),
    auth,
    role("mechanic"),
    approved
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
          "SELECT id,full_name,phone_number,user_type,availability,locality,specialization,location_latitude,location_longitude,mechanic_review_status,preferred_language FROM users WHERE id=$1",
          [req.user.id]
        )
      ).rows[0],
    auth
  );
  route(
    "patch",
    "/api/users/profile",
    async (req) => {
      if(req.body.availability===true && req.user.user_type==='mechanic') await requireApproved(pool,req.user.id);
      if (req.body.latitude != null) coordinates(req.body);
      const result = (
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
      await reconcileRequestAlerts(pool,req.user.id);
      return result;
    },
    auth
  );
  route('get','/api/users/:id',async req=>{
    const user=(await pool.query('SELECT id,full_name,user_type,locality,specialization,mechanic_review_status FROM users WHERE id=$1',[req.params.id])).rows[0];
    if(!user) throw new WorkflowError('User not found',404);
    const driver=req.user.user_type==='driver'?req.user.id:user.id, mechanic=req.user.user_type==='mechanic'?req.user.id:user.id;
    let can_message=false;try{await chatJourney(pool,driver,mechanic);can_message=true;}catch(e){if(!(e instanceof WorkflowError))throw e;}
    const p=user.user_type==='mechanic'&&user.mechanic_review_status==='approved'?(await pool.query('SELECT public_details,portrait,garage_photo FROM mechanic_profiles WHERE user_id=$1',[user.id])).rows[0]:null;
    const phone=can_message?(await pool.query('SELECT phone_number FROM users WHERE id=$1',[user.id])).rows[0].phone_number:null;
    return {...user,...(p?.public_details||{}),portrait:p?.portrait,garage_photo:p?.garage_photo,can_message,phone};
  },auth);
  route(
    "get",
    "/api/mechanics/available",
    async (req) => {
      const lat = Number(req.query.latitude),
        lon = Number(req.query.longitude);
      coordinates({ latitude: lat, longitude: lon });
      let rows = (
        await pool.query(
          "SELECT id,full_name,locality,specialization,location_latitude,location_longitude,location_updated_at FROM users WHERE user_type='mechanic' AND availability=TRUE AND NOT suspended AND is_active=TRUE AND mechanic_review_status='approved' AND location_updated_at>CURRENT_TIMESTAMP-INTERVAL '24 hours' AND location_latitude IS NOT NULL LIMIT 500"
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
      return rows.filter(r => r.distance_m <= 5000).sort(
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
          "SELECT s.*,u.full_name AS mechanic_name FROM service_offers s JOIN users u ON u.id=s.mechanic_id WHERE s.is_active=TRUE AND u.mechanic_review_status='approved' AND NOT u.suspended AND u.is_active=TRUE ORDER BY s.id DESC LIMIT 100"
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
    role("mechanic"),
    approved
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
    role("mechanic"),
    approved
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
    role("mechanic"),
    approved
  );
  route('post','/api/conversations',req=>tx(async c=>{
    const other=(await c.query('SELECT id,user_type FROM users WHERE id=$1',[req.body.other_user_id])).rows[0];
    if(!other||other.user_type===req.user.user_type)throw new WorkflowError('Choose a driver and mechanic',400);
    const driver=req.user.user_type==='driver'?req.user.id:other.id,mechanic=req.user.user_type==='mechanic'?req.user.id:other.id;
    const j=await chatJourney(c,driver,mechanic);
    return (await c.query('INSERT INTO conversations(driver_id,mechanic_id,repair_request_id,journey_id) VALUES($1,$2,$3,$4) ON CONFLICT(journey_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP RETURNING *',[driver,mechanic,j.repair_request_id,j.id])).rows[0];
  }),auth);
  route('get','/api/conversations',async req=>(await pool.query("SELECT c.*,d.full_name AS driver_name,m.full_name AS mechanic_name,j.status AS journey_status FROM conversations c JOIN journeys j ON j.id=c.journey_id JOIN users d ON d.id=c.driver_id JOIN users m ON m.id=c.mechanic_id WHERE c.driver_id=$1 OR c.mechanic_id=$1 ORDER BY c.updated_at DESC",[req.user.id])).rows,auth);
  async function conversation(c,id,user,write=false){
    const row=(await c.query('SELECT c.*,j.status,j.expires_at FROM conversations c JOIN journeys j ON j.id=c.journey_id WHERE c.id=$1 AND (c.driver_id=$2 OR c.mechanic_id=$2)'+(write?' FOR UPDATE OF j':''),[id,user])).rows[0];
    if(!row)throw new WorkflowError('Conversation access denied',403);
    if(write){const j=await chatJourney(c,row.driver_id,row.mechanic_id);if(j.id!==row.journey_id)throw new WorkflowError('Start a conversation for the current journey',403);}
    return row;
  }
  route('get','/api/conversations/:id',async req=>{const row=await conversation(pool,req.params.id,req.user.id);return {id:row.id,can_send:['active','driver_arrived','mechanic_arrived','both_arrived','service_started','service_completed'].includes(row.status)&&new Date(row.expires_at)>new Date()};},auth);
  route('get','/api/conversations/:id/messages',async req=>{
    await conversation(pool,req.params.id,req.user.id);
    return (await pool.query('SELECT m.id,m.sender_id,m.sender_type,m.message_text,m.created_at,m.audio_duration,(m.audio_note IS NOT NULL) AS has_audio,u.full_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE conversation_id=$1 ORDER BY m.id DESC LIMIT 100',[req.params.id])).rows.reverse();
  },auth);
  route('post','/api/conversations/:id/messages',req=>tx(async c=>{
    await conversation(c,req.params.id,req.user.id,true);
    const voice=audioNote(req.body);
    const message=String(req.body.message_text||'').trim();if((!message&&!voice.note)||message.length>2000)throw new WorkflowError('Message must contain 1 to 2000 characters',400);
    return (await c.query('INSERT INTO messages(conversation_id,sender_id,sender_type,message_text,audio_note,audio_duration) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,conversation_id,sender_id,sender_type,message_text,audio_duration,(audio_note IS NOT NULL) AS has_audio',[req.params.id,req.user.id,req.user.user_type,message,voice.note,voice.duration])).rows[0];
  }),auth);
  async function requestAudioAccess(req,id){
    const r=(await pool.query('SELECT id,driver_id,latitude,longitude FROM repair_requests WHERE id=$1',[id])).rows[0];if(!r)throw new WorkflowError('Request not found',404);
    if(req.user.user_type==='driver'&&r.driver_id!==req.user.id)throw new WorkflowError('Request access denied',403);
    if(req.user.user_type==='mechanic')await requestAudience(pool,req.user.id,r);
  }
  route('get','/api/repair-requests/:id/audio',async req=>{await requestAudioAccess(req,req.params.id);const row=(await pool.query('SELECT audio_note,audio_duration FROM repair_requests WHERE id=$1',[req.params.id])).rows[0];if(!row.audio_note)throw new WorkflowError('Voice note not found',404);return row;},auth);
  route('get','/api/quotes/:id/audio',async req=>{const q=(await pool.query('SELECT * FROM quotes WHERE id=$1',[req.params.id])).rows[0];if(!q)throw new WorkflowError('Response not found',404);const r=(await pool.query('SELECT id,driver_id,latitude,longitude FROM repair_requests WHERE id=$1',[q.repair_request_id])).rows[0];if(req.user.id!==q.mechanic_id&&req.user.id!==r.driver_id)throw new WorkflowError('Response access denied',403);if(!q.audio_note)throw new WorkflowError('Voice note not found',404);return {audio_note:q.audio_note,audio_duration:q.audio_duration};},auth);
  route('get','/api/messages/:id/audio',async req=>{const m=(await pool.query('SELECT * FROM messages WHERE id=$1',[req.params.id])).rows[0];if(!m)throw new WorkflowError('Voice note not found',404);await conversation(pool,m.conversation_id,req.user.id);if(!m.audio_note)throw new WorkflowError('Voice note not found',404);return {audio_note:m.audio_note,audio_duration:m.audio_duration};},auth);
  route('patch','/api/users/language',async req=>{if(!['en','fr'].includes(req.body.language))throw new WorkflowError('Choose English or French',400);await pool.query('UPDATE users SET preferred_language=$1 WHERE id=$2',[req.body.language,req.user.id]);return {language:req.body.language};},auth);
  route('get','/api/mechanic-profile',async req=>{
    const p=(await pool.query('SELECT * FROM mechanic_profiles WHERE user_id=$1',[req.user.id])).rows[0];
    const u=(await pool.query('SELECT full_name,phone_number,mechanic_review_status FROM users WHERE id=$1',[req.user.id])).rows[0];
    return {...u,...(p?{...p.public_details,...reveal(p.private_cipher),portrait:p.portrait,garage_photo:p.garage_photo,review_note:p.review_note}: {})};
  },auth,role('mechanic'));
  route('put','/api/mechanic-profile',req=>tx(async c=>{
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
    const active=(await c.query("SELECT id FROM journeys WHERE mechanic_id=$1 AND status IN ('active','driver_arrived','mechanic_arrived','both_arrived','service_started','service_completed')",[req.user.id])).rows;
    if(active.length)throw new WorkflowError('Finish your current journey before submitting profile changes',409);
    const p=validateProfile(req.body);
    await c.query("INSERT INTO mechanic_profiles(user_id,public_details,private_cipher,portrait,garage_photo) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET public_details=EXCLUDED.public_details,private_cipher=EXCLUDED.private_cipher,portrait=EXCLUDED.portrait,garage_photo=EXCLUDED.garage_photo,review_note='',submitted_at=CURRENT_TIMESTAMP,reviewed_at=NULL,reviewed_by=NULL",[req.user.id,JSON.stringify(p.publicDetails),protect(p.privateDetails),p.portrait,p.garagePhoto]);
    await c.query("UPDATE users SET mechanic_review_status='pending',availability=FALSE,full_name=$1,locality=$2,specialization=$3 WHERE id=$4",[p.publicDetails.full_name,p.publicDetails.locality,p.publicDetails.specialization,req.user.id]);
    return {mechanic_review_status:'pending'};
  }),auth,role('mechanic'));
  route('get','/api/admin/mechanic-profiles',async req=>(await pool.query("SELECT u.id,u.full_name,u.phone_number,u.mechanic_review_status,p.public_details,p.submitted_at,p.review_note FROM users u LEFT JOIN mechanic_profiles p ON p.user_id=u.id WHERE u.user_type='mechanic' ORDER BY p.submitted_at DESC NULLS LAST LIMIT 500")).rows,auth,admin);
  route('get','/api/admin/mechanic-profiles/:id',async req=>{
    const p=(await pool.query('SELECT * FROM mechanic_profiles WHERE user_id=$1',[req.params.id])).rows[0];if(!p)throw new WorkflowError('Profile not submitted',404);
    await pool.query("INSERT INTO admin_audit(admin_id,action,details) VALUES($1,'view_mechanic_identity',$2)",[req.user.id,JSON.stringify({userId:Number(req.params.id)})]);
    return {...p.public_details,...reveal(p.private_cipher),portrait:p.portrait,garage_photo:p.garage_photo,review_note:p.review_note};
  },auth,admin);
  route('patch','/api/admin/mechanic-profiles/:id',req=>tx(async c=>{
    if(!['approved','rejected'].includes(req.body.status))throw new WorkflowError('Choose approved or rejected',400);
    const note=String(req.body.note||'').trim();if(note.length>1000||req.body.status==='rejected'&&!note)throw new WorkflowError('Give a reason when rejecting a profile',400);
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.params.id]);
    const p=(await c.query('SELECT * FROM mechanic_profiles WHERE user_id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!p)throw new WorkflowError('Profile not submitted',404);
    if(req.body.status==='approved')validateProfile({...p.public_details,...reveal(p.private_cipher),portrait:p.portrait,garage_photo:p.garage_photo,consent:true});
    await c.query('UPDATE users SET mechanic_review_status=$1,availability=FALSE WHERE id=$2',[req.body.status,req.params.id]);
    await c.query('UPDATE mechanic_profiles SET review_note=$1,reviewed_at=CURRENT_TIMESTAMP,reviewed_by=$2 WHERE user_id=$3',[note,req.user.id,req.params.id]);
    await c.query("INSERT INTO admin_audit(admin_id,action,details) VALUES($1,'review_mechanic_profile',$2)",[req.user.id,JSON.stringify({userId:Number(req.params.id),status:req.body.status})]);return {status:req.body.status};
  }),auth,admin);
  route('get','/api/admin/notifications',async req=>(await pool.query('SELECT o.id,o.repair_request_id,o.user_id,o.kind,o.status,o.attempts,o.last_error,o.sent_at FROM push_outbox o ORDER BY o.id DESC LIMIT 100')).rows,auth,admin);
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
