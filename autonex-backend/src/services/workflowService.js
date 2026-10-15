import {audioNote} from './audioService.js';
import {requireApproved,requestAudience} from './profileService.js';
import {
  randomInt,
  randomBytes,
  createHmac,
  createCipheriv,
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  WorkflowError,
  amount,
  reserveFee,
  releaseAllUnreleasedFees,
  collectFees,
  getFeeConfig,
} from "./feeService.js";
export function distance(a, b) {
  const rad = (x) => (Number(x) * Math.PI) / 180;
  const p = rad(b.latitude - a.latitude),
    q = rad(b.longitude - a.longitude);
  const x =
    Math.sin(p / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(q / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
export function coordinates(x) {
  if (
    typeof x.latitude !== "number" ||
    typeof x.longitude !== "number" ||
    !Number.isFinite(x.latitude) ||
    !Number.isFinite(x.longitude) ||
    Math.abs(x.latitude) > 90 ||
    Math.abs(x.longitude) > 180
  )
    throw new WorkflowError("Valid destination coordinates are required", 400);
}
export async function transaction(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const key = () =>
  createHash("sha256")
    .update(process.env.PIN_SECRET || "")
    .digest();
function hash(pin, id) {
  return createHmac("sha256", key()).update(`${id}:${pin}`).digest("hex");
}
function encrypt(pin) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString("hex"))
    .join(":");
}
export function revealPin(j) {
  const [iv, tag, data] = j.driver_pin_cipher
    .split(":")
    .map((x) => Buffer.from(x, "hex"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString();
}
async function request(c, id) {
  const r = (
    await c.query("SELECT * FROM repair_requests WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (!r) throw new WorkflowError("Request not found", 404);
  return r;
}
export async function journey(c, id, user) {
  const base = (
    await c.query("SELECT repair_request_id FROM journeys WHERE id=$1", [id])
  ).rows[0];
  if (!base) throw new WorkflowError("Journey not found", 404);
  await request(c, base.repair_request_id); // all operations acquire request -> journey -> wallets
  const j = (
    await c.query("SELECT * FROM journeys WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (user !== j.driver_id && user !== j.mechanic_id)
    throw new WorkflowError("Journey access denied", 403);
  return j;
}
function open(r) {
  if (r.status !== "open" || new Date(r.expires_at) <= new Date())
    throw new WorkflowError("Request is closed or expired");
}
export async function createRequest(c, user, data) {
  coordinates(data);
  const voice=audioNote(data);
  if(String(data.title||'').length>200 || String(data.description||'').length>4000 || String(data.location||'').length>500)throw new WorkflowError('Request text is too long',400);
  if (!String(data.title || "").trim() || !String(data.location || "").trim())
    throw new WorkflowError("Title and location are required", 400);
  const cfg = await getFeeConfig(c);
  const r = (
    await c.query(
      "INSERT INTO repair_requests(driver_id,title,description,vehicle_type,location,latitude,longitude) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [
        user,
        data.title,
        data.description || "",
        data.vehicle_type || "car",
        data.location,
        data.latitude,
        data.longitude,
      ]
    )
  ).rows[0];
  if(voice.note)await c.query('UPDATE repair_requests SET audio_note=$1,audio_duration=$2 WHERE id=$3',[voice.note,voice.duration,r.id]);
  const reservation = await reserveFee(user, r.id, "connection_fee_driver", cfg.driverFee, c);
  return { ...r, feeReserved: reservation.amount > 0, feeAmount: reservation.amount, freeTrial: reservation.amount === 0 };
}
export async function respond(c, user, id, data) {
  await requireApproved(c,user);
  const voice=audioNote(data);
  if(String(data.description||'').length>4000)throw new WorkflowError('Response text is too long',400);
  if (data.quoted_price != null) amount(data.quoted_price);
  const r = await request(c, id);
  open(r);
  await requestAudience(c,user,r,{newResponse:true});
  if(r.target_mechanic_id){
    if(r.connection_stage!=='offer')throw new WorkflowError('Wait for the driver problem description',409);
    if(data.description||data.audio_note||data.quoted_price!=null||data.estimated_time)throw new WorkflowError('Only a displacement fee is allowed before approval',400);
    if(!Number.isSafeInteger(data.displacement_fee_xaf)||data.displacement_fee_xaf<0||data.displacement_fee_xaf>2147483647)throw new WorkflowError('Enter a nonnegative whole XAF displacement fee',400);
  }
  if (
    (
      await c.query(
        "SELECT id FROM quotes WHERE repair_request_id=$1 AND mechanic_id=$2 AND status IN ('pending','accepted')",
        [id, user]
      )
    ).rows.length
  )
    throw new WorkflowError("Response already submitted");
  const cfg = await getFeeConfig(c);
  await reserveFee(user, r.id, "connection_fee_mechanic", cfg.mechanicFee, c);
  const response=(
    await c.query(
      "INSERT INTO quotes(repair_request_id,mechanic_id,quoted_price,estimated_time,description,audio_note,audio_duration) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [
        id,
        user,
        data.quoted_price || null,
        data.estimated_time || "",
        data.description || "", voice.note,voice.duration,
      ]
    )
  ).rows[0];
  if(r.target_mechanic_id){await c.query('UPDATE quotes SET displacement_fee_xaf=$1 WHERE id=$2',[data.displacement_fee_xaf,response.id]);await c.query("UPDATE repair_requests SET connection_stage='offered' WHERE id=$1",[r.id]);response.displacement_fee_xaf=data.displacement_fee_xaf;}
  return response;
}
export async function select(c, user, quoteId) {
  const q = (await c.query("SELECT * FROM quotes WHERE id=$1", [quoteId]))
    .rows[0];
  if (!q) throw new WorkflowError("Response not found", 404);
  const r = await request(c, q.repair_request_id);
  if (r.driver_id !== user)
    throw new WorkflowError("Request access denied", 403);
  const old = (
    await c.query("SELECT * FROM journeys WHERE repair_request_id=$1", [r.id])
  ).rows[0];
  if (old) {
    if (old.mechanic_id !== q.mechanic_id)
      throw new WorkflowError("A mechanic is already selected");
    return { ...q, journey: publicJourney(old) };
  }
  await requireApproved(c,q.mechanic_id);
  open(r);
  if(r.target_mechanic_id && (r.target_mechanic_id!==q.mechanic_id || r.connection_stage!=='offered'))throw new WorkflowError('Displacement offer is no longer current',409);
  if (q.status !== "pending")
    throw new WorkflowError("Response no longer available");
  const rs = (
    await c.query(
      "SELECT user_id FROM connection_credit_reservations WHERE repair_request_id=$1 AND status='reserved' AND user_id IN ($2,$3)",
      [r.id, user, q.mechanic_id]
    )
  ).rows;
  if (rs.length !== 2) throw new WorkflowError("Both credit holds required");
  const j = (
    await c.query(
      "INSERT INTO journeys(repair_request_id,driver_id,mechanic_id,destination_latitude,destination_longitude) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [r.id, user, q.mechanic_id, r.latitude, r.longitude]
    )
  ).rows[0];
  const pin = String(randomInt(1000, 10000));
  await c.query(
    "UPDATE journeys SET driver_pin_hash=$1,driver_pin_cipher=$2,driver_pin_expires_at=CURRENT_TIMESTAMP+INTERVAL '15 minutes' WHERE id=$3",
    [hash(pin, j.id), encrypt(pin), j.id]
  );
  await c.query(
    "UPDATE quotes SET status=CASE WHEN id=$1 THEN 'accepted' ELSE 'rejected' END WHERE repair_request_id=$2 AND status='pending'",
    [q.id, r.id]
  );
  // retain driver and selected mechanic only
  const others = (
    await c.query(
      "SELECT id FROM connection_credit_reservations WHERE repair_request_id=$1 AND status='reserved' AND user_id NOT IN ($2,$3) ORDER BY user_id",
      [r.id, user, q.mechanic_id]
    )
  ).rows;
  const { releaseFee } = await import("./feeService.js");
  for (const a of others)
    await releaseFee(a.id, "Another mechanic selected", c);
  await c.query(
    "UPDATE connection_credit_reservations SET journey_id=$1 WHERE repair_request_id=$2 AND status='reserved'",
    [j.id, r.id]
  );
  await c.query("UPDATE repair_requests SET status='accepted' WHERE id=$1", [
    r.id,
  ]);
  if(r.target_mechanic_id){await collectFees(j.id,user,q.mechanic_id,c,'10 credits charged when driver approved displacement fee');await c.query("UPDATE repair_requests SET connection_stage='connected' WHERE id=$1",[r.id]);j.both_fees_collected=true;j.connection_fee_collected=true;}
  await c.query('INSERT INTO conversations(driver_id,mechanic_id,repair_request_id,journey_id) VALUES($1,$2,$3,$4) ON CONFLICT(journey_id) DO NOTHING',[user,q.mechanic_id,r.id,j.id]);
  return { ...q, status: "accepted", journey: publicJourney(j) };
}
export async function cancelRequest(c, user, id, reason = "Driver cancelled") {
  const r = await request(c, id);
  if (r.driver_id !== user)
    throw new WorkflowError("Request access denied", 403);
  const j = (
    await c.query(
      "SELECT * FROM journeys WHERE repair_request_id=$1 FOR UPDATE",
      [id]
    )
  ).rows[0];
  if (j?.both_fees_collected)
    throw new WorkflowError(
      "Arrival fee already collected; contact support for refund"
    );
  if (r.status === "cancelled" || r.status === "expired") return r;
  if(r.target_mechanic_id){const {queueAlertStop}=await import('./pushService.js');await queueAlertStop(c,r.id,r.target_mechanic_id,r.direct_attempt);}
  await releaseAllUnreleasedFees(id, reason, c);
  await c.query("UPDATE repair_requests SET status='cancelled' WHERE id=$1", [
    id,
  ]);
  await c.query(
    "UPDATE quotes SET status='expired' WHERE repair_request_id=$1 AND status='pending'",
    [id]
  );
  if (j)
    await c.query(
      "UPDATE journeys SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancellation_reason=$1 WHERE id=$2",
      [reason, j.id]
    );
  return { status: "cancelled" };
}
export async function cancelJourney(c, user, id, reason = "Journey cancelled") {
  const j = await journey(c, id, user);
  if (j.both_fees_collected) {const r=(await c.query('SELECT connection_stage FROM repair_requests WHERE id=$1',[j.repair_request_id])).rows[0];if(r.connection_stage!=='connected')throw new WorkflowError('Fees already collected; contact support');}
  if (["cancelled", "expired"].includes(j.status)) return { status: j.status };
  await releaseAllUnreleasedFees(j.repair_request_id, reason, c);
  await c.query(
    "UPDATE journeys SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancellation_reason=$1 WHERE id=$2",
    [reason, id]
  );
  await c.query("UPDATE repair_requests SET status='cancelled' WHERE id=$1", [
    j.repair_request_id,
  ]);
  return { status: "cancelled" };
}
export async function reportLocation(c, user, id, data) {
  const j = await journey(c, id, user);
  if (j.mechanic_id !== user)
    throw new WorkflowError("Mechanic location required", 403);
  if (j.status !== "active") throw new WorkflowError("Journey is not active");
  coordinates(data);
  if (!Number.isFinite(data.accuracy) || data.accuracy < 0)
    throw new WorkflowError("Valid GPS accuracy required", 400);
  const t = new Date(data.timestamp);
  if (
    !Number.isFinite(t.getTime()) ||
    Math.abs(Date.now() - t.getTime()) > 30000
  )
    throw new WorkflowError("GPS sample is stale", 400);
  const last = (
    await c.query(
      "SELECT * FROM location_tracking WHERE journey_id=$1 AND user_id=$2 ORDER BY timestamp DESC,id DESC LIMIT 1",
      [id, user]
    )
  ).rows[0];
  if (last) {
    const dt = (t - new Date(last.sampled_at)) / 1000;
    if (dt <= 0) throw new WorkflowError("GPS samples must be newer", 400);
    if (distance(last, data) / dt > 60)
      throw new WorkflowError("Implausible location jump", 400);
  }
  await c.query(
    "INSERT INTO location_tracking(user_id,journey_id,latitude,longitude,accuracy,sampled_at) VALUES($1,$2,$3,$4,$5,$6)",
    [user, id, data.latitude, data.longitude, data.accuracy, t]
  );
  const mode = (await c.query("SELECT config_value FROM admin_config WHERE config_key='automatic_gps_arrival'")).rows[0]?.config_value;
  if (mode === 'true') {
    try { return { recorded: true, ...await verifyArrival(c, user, id, null, true) }; }
    catch (e) { if (e instanceof WorkflowError && e.status === 422) return { recorded: true, verified: false, reason: e.message }; throw e; }
  }
  return { recorded: true };
}
export async function verifyArrival(c, user, id, pin, automatic = false) {
  const j = await journey(c, id, user);
  if (j.mechanic_id !== user)
    throw new WorkflowError("Selected mechanic must verify arrival", 403);
  if (j.both_fees_collected && j.status==='both_arrived') return { verified: true, alreadyCollected: true };
  if (j.status !== "active" || new Date(j.expires_at) <= new Date())
    throw new WorkflowError("Journey is closed or expired");
  const cfg = Object.fromEntries(
    (
      await c.query(
        "SELECT config_key,config_value FROM admin_config WHERE config_key LIKE 'arrival_%' OR config_key='location_fresh_s'"
      )
    ).rows.map((r) => [r.config_key, Number(r.config_value)])
  );
  const now = Date.now(),
    dwell = cfg.arrival_dwell_s || 10,
    fresh = cfg.location_fresh_s || 30;
  const samples = (
    await c.query(
      "SELECT * FROM location_tracking WHERE user_id=$1 AND journey_id=$2 AND timestamp>=CURRENT_TIMESTAMP-INTERVAL '60 seconds' ORDER BY timestamp DESC,id DESC",
      [user, id]
    )
  ).rows;
  let oldest = null,
    newest = null,
    previous = null;
  for (const s of samples) {
    const received = new Date(s.timestamp).getTime(),
      sampled = new Date(s.sampled_at).getTime();
    if (
      now - received > fresh * 1000 ||
      now - sampled > fresh * 1000 ||
      !Number.isFinite(sampled) ||
      s.accuracy == null ||
      Number(s.accuracy) > (cfg.arrival_accuracy_m || 30) ||
      distance(s, {
        latitude: j.destination_latitude,
        longitude: j.destination_longitude,
      }) > (cfg.arrival_radius_m || 50)
    )
      break;
    if (previous && previous - received > 15000) break;
    newest ??= s;
    oldest = s;
    previous = received;
  }
  if (
    !oldest ||
    new Date(newest.timestamp) - new Date(oldest.timestamp) < dwell * 1000 ||
    new Date(newest.sampled_at) - new Date(oldest.sampled_at) < dwell * 1000
  )
    throw new WorkflowError(
      "Fresh accurate GPS dwell at destination is required",
      422
    );
  if (!automatic) {
  if (j.pin_attempts >= 3 || new Date(j.driver_pin_expires_at) <= new Date())
    throw new WorkflowError(
      "Arrival PIN locked or expired; driver must refresh it",
      422
    );
  const valid =
    /^\d{4}$/.test(String(pin)) &&
    timingSafeEqual(
      Buffer.from(hash(String(pin), id), "hex"),
      Buffer.from(j.driver_pin_hash, "hex")
    );
  if (!valid) {
    await c.query(
      "UPDATE journeys SET pin_attempts=pin_attempts+1 WHERE id=$1",
      [id]
    );
    return {
      verified: false,
      reason: "invalid_pin",
      attemptsRemaining: 2 - j.pin_attempts,
    };
  }
  }
  await c.query(
    "UPDATE journeys SET status='both_arrived',mechanic_arrival_time=CURRENT_TIMESTAMP,mechanic_arrival_latitude=$1,mechanic_arrival_longitude=$2 WHERE id=$3",
    [newest.latitude, newest.longitude, id]
  );
  const fees = await collectFees(id, j.driver_id, j.mechanic_id, c);
  return { verified: true, feesCollected: true, feeDetails: fees };
}
export async function refreshPin(c, user, id) {
  const j = await journey(c, id, user);
  if (j.driver_id !== user)
    throw new WorkflowError("Only driver can refresh arrival PIN", 403);
  if (j.status !== "active") throw new WorkflowError("Journey is closed");
  const pin = String(randomInt(1000, 10000));
  await c.query(
    "UPDATE journeys SET driver_pin_hash=$1,driver_pin_cipher=$2,driver_pin_expires_at=CURRENT_TIMESTAMP+INTERVAL '15 minutes',pin_attempts=0 WHERE id=$3",
    [hash(pin, id), encrypt(pin), id]
  );
  return { pin, expiresInMinutes: 15 };
}
export async function expire(pool) {
  const { rows } = await pool.query(
    "SELECT id FROM repair_requests WHERE status='open' AND expires_at<=CURRENT_TIMESTAMP UNION SELECT repair_request_id AS id FROM journeys WHERE status='active' AND expires_at<=CURRENT_TIMESTAMP"
  );
  for (const r of rows)
    await transaction(pool, async (c) => {
      const req = await request(c, r.id);
      const j = (
        await c.query(
          "SELECT * FROM journeys WHERE repair_request_id=$1 FOR UPDATE",
          [r.id]
        )
      ).rows[0];
      if (j?.both_fees_collected && req.connection_stage!=='connected') return;
      if (
        !(req.status === "open" && new Date(req.expires_at) <= new Date()) &&
        !(j?.status === "active" && new Date(j.expires_at) <= new Date())
      )
        return;
      if(req.target_mechanic_id){const {queueAlertStop}=await import('./pushService.js');await queueAlertStop(c,req.id,req.target_mechanic_id,req.direct_attempt);}
      await releaseAllUnreleasedFees(req.id, "Request or journey expired", c);
      await c.query("UPDATE repair_requests SET status='expired' WHERE id=$1", [
        req.id,
      ]);
      await c.query(
        "UPDATE quotes SET status='expired' WHERE repair_request_id=$1 AND status='pending'",
        [req.id]
      );
      if (j)
        await c.query("UPDATE journeys SET status='expired' WHERE id=$1", [
          j.id,
        ]);
    });
  return rows.length;
}

export function publicJourney(j) {
  const {
    driver_pin_hash,
    driver_pin_cipher,
    driver_arrival_pin,
    mechanic_arrival_pin,
    ...safe
  } = j;
  return safe;
}
