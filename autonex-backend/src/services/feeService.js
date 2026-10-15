// Every mutation uses the caller's transaction. Request row is locked before these calls.
export class WorkflowError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}
export function amount(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw new WorkflowError("Use a positive whole FCFA amount", 400);
  return value;
}
export async function getFeeConfig() {
  return {driverFee:10,mechanicFee:10,unit:'credits'};
}
export async function grantWelcomeCredit(c,user) {
  await c.query('INSERT INTO connection_credit_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING',[user]);
  const w=(await c.query('SELECT * FROM connection_credit_accounts WHERE user_id=$1 FOR UPDATE',[user])).rows[0];
  const g=await c.query('INSERT INTO connection_credit_grants(user_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING user_id',[user]);
  if(!g.rows.length)return false;
  await c.query('UPDATE connection_credit_accounts SET balance=balance+20 WHERE user_id=$1',[user]);
  await c.query("INSERT INTO connection_credit_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description) VALUES($1,'welcome',20,$2,$3,'signup',$4,'One-time 20 free connection credits')",[user,w.balance,w.balance+20,'welcome_'+user]);
  return true;
}
async function audit(c,user,request,journey,operation,type,value,before,after,reason,reservationId) {
  const connection=journey?(await c.query('SELECT connection_reference FROM journeys WHERE id=$1',[journey])).rows[0]?.connection_reference:null;
  await c.query(`INSERT INTO connection_credit_transactions(user_id,connection_reference,transaction_type,amount,balance_before,balance_after,source,reference_id,description)
    VALUES($1,$2,$3,$4,$5,$6,'connection',$7,$8)`,[user,connection,{reserve:'reservation',collect:'fee_collection',release:'reservation_release'}[operation],operation==='collect'?-value:0,before,after,operation==='collect'?connection:'hold_'+reservationId,reason]);
}
export async function reserveFee(user, request, type, value, c) {
  if(value!==10)throw new WorkflowError('Each connection costs 10 credits',400);
  const wallet = (
    await c.query("SELECT * FROM connection_credit_accounts WHERE user_id=$1 FOR UPDATE", [user])
  ).rows[0];
  if (!wallet || wallet.balance - wallet.reserved < value)
    throw new WorkflowError("Insufficient available connection credits", 402);
  const old = (
    await c.query(
      "SELECT id FROM connection_credit_reservations WHERE user_id=$1 AND repair_request_id=$2 AND fee_type=$3 AND status IN ('reserved','collected')",
      [user, request, type]
    )
  ).rows[0];
  if (old) throw new WorkflowError("Fee already reserved");
  const r = (
    await c.query(
      "INSERT INTO connection_credit_reservations(user_id,repair_request_id,reservation_type,fee_type,amount,status) VALUES($1,$2,'connection_fee',$3,$4,'reserved') RETURNING *",
      [user, request, type, value]
    )
  ).rows[0];
  await c.query("UPDATE connection_credit_accounts SET reserved=reserved+$1 WHERE user_id=$2", [
    value,
    user,
  ]);
  await audit(
    c,
    user,
    request,
    null,
    "reserve",
    type,
    value,
    wallet.balance,
    wallet.balance,
    "10 connection credits held; not yet charged",
    r.id
  );
  return r;
}
export async function releaseFee(id, reason, c) {
  const r = (
    await c.query("SELECT * FROM connection_credit_reservations WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (!r || r.status !== "reserved") return false;
  const w = (
    await c.query("SELECT * FROM connection_credit_accounts WHERE user_id=$1 FOR UPDATE", [
      r.user_id,
    ])
  ).rows[0];
  if (w.reserved < r.amount)
    throw new WorkflowError("Credit reservation mismatch");
  await c.query("UPDATE connection_credit_accounts SET reserved=reserved-$1 WHERE user_id=$2", [
    r.amount,
    r.user_id,
  ]);
  await c.query(
    "UPDATE connection_credit_reservations SET status='released',released_at=CURRENT_TIMESTAMP,release_reason=$1 WHERE id=$2",
    [reason, id]
  );
  await audit(
    c,
    r.user_id,
    r.repair_request_id,
    r.journey_id,
    "release",
    r.fee_type,
    r.amount,
    w.balance,
    w.balance,
    reason,
    r.id
  );
  return true;
}
export async function releaseAllUnreleasedFees(
  request,
  reason,
  c,
  exceptUser = null
) {
  const { rows } = await c.query(
    "SELECT id FROM connection_credit_reservations WHERE repair_request_id=$1 AND status='reserved' AND ($2::int IS NULL OR user_id<>$2) ORDER BY user_id,id",
    [request, exceptUser]
  );
  for (const r of rows) await releaseFee(r.id, reason, c);
}
export async function collectFees(journeyId, driver, mechanic, c, reason='10 credits charged after verified mechanic GPS arrival') {
  const j = (
    await c.query("SELECT * FROM journeys WHERE id=$1 FOR UPDATE", [journeyId])
  ).rows[0];
  if (j.both_fees_collected) return { alreadyCollected: true };
  if(j.status!=='both_arrived'){const r=(await c.query('SELECT target_mechanic_id,connection_stage,status FROM repair_requests WHERE id=$1',[j.repair_request_id])).rows[0];if(!(j.status==='active'&&r.target_mechanic_id===mechanic&&r.connection_stage==='offered'&&r.status==='accepted'))throw new WorkflowError('Verified arrival or approved displacement offer required');}
  const rs = (
    await c.query(
      "SELECT * FROM connection_credit_reservations WHERE repair_request_id=$1 AND user_id IN ($2,$3) AND status='reserved' ORDER BY user_id FOR UPDATE",
      [j.repair_request_id, driver, mechanic]
    )
  ).rows;
  if (
    rs.length !== 2 ||
    !rs.some(
      (r) => r.user_id === driver && r.fee_type === "connection_fee_driver"
    ) ||
    !rs.some(
      (r) => r.user_id === mechanic && r.fee_type === "connection_fee_mechanic"
    )
  )
    throw new WorkflowError("Both connection fee connection_credit_reservations are required");
  for (const r of rs) {
    const w = (
      await c.query("SELECT * FROM connection_credit_accounts WHERE user_id=$1 FOR UPDATE", [
        r.user_id,
      ])
    ).rows[0];
    if (w.reserved < r.amount || w.balance < r.amount)
      throw new WorkflowError("Credit reservation mismatch");
    await c.query(
      "UPDATE connection_credit_accounts SET balance=balance-$1,reserved=reserved-$1 WHERE user_id=$2",
      [r.amount, r.user_id]
    );
    await c.query(
      "UPDATE connection_credit_reservations SET status='collected',collected_at=CURRENT_TIMESTAMP WHERE id=$1",
      [r.id]
    );
    await audit(
      c,
      r.user_id,
      j.repair_request_id,
      j.id,
      "collect",
      r.fee_type,
      r.amount,
      w.balance,
      w.balance - r.amount,
      reason
    );
  }
  await c.query(
    "UPDATE journeys SET both_fees_collected=TRUE,both_fees_collected_at=CURRENT_TIMESTAMP,connection_fee_collected=TRUE WHERE id=$1",
    [j.id]
  );
  return { totalCollected: rs.reduce((s, r) => s + r.amount, 0) };
}
