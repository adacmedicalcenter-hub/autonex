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
export async function getFeeConfig(client) {
  const { rows } = await client.query(
    "SELECT config_key,config_value FROM admin_config WHERE config_key IN ('connection_fee_driver','connection_fee_mechanic','environment')"
  );
  const cfg = Object.fromEntries(
    rows.map((r) => [r.config_key, r.config_value])
  );
  return {
    driverFee: amount(Number(cfg.connection_fee_driver)),
    mechanicFee: amount(Number(cfg.connection_fee_mechanic)),
    environment: cfg.environment,
  };
}
export async function grantWelcomeCredit(c, user) {
  const wallet = (await c.query('SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE',[user])).rows[0];
  if (!wallet) throw new WorkflowError('Wallet not found',404);
  const value = 2000; // Pilot grant. Production 1,000 FCFA is a separate release decision.
  const grant = await c.query("INSERT INTO welcome_credit_grants(user_id,amount) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING RETURNING user_id",[user,value]);
  if (!grant.rows.length) return false;
  await c.query('UPDATE wallets SET balance=balance+$1 WHERE user_id=$2',[value,user]);
  await c.query("INSERT INTO wallet_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description) VALUES($1,'topup',$2,$3,$4,'welcome_credit',$5,'One-time nonwithdrawable RESQUORA welcome credit')",[user,value,wallet.balance,wallet.balance+value,'welcome_'+user]);
  return true;
}
async function audit(
  c,
  user,
  request,
  journey,
  operation,
  type,
  value,
  before,
  after,
  reason
) {
  await c.query(
    "INSERT INTO fee_log(user_id,journey_id,operation,fee_type,amount,status,reason) VALUES($1,$2,$3,$4,$5,'completed',$6)",
    [user, journey, operation, type, value, reason]
  );
  await c.query(
    "INSERT INTO wallet_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description) VALUES($1,$2,$3,$4,$5,'connection_fee',$6,$7)",
    [
      user,
      {
        reserve: "reservation",
        collect: "fee_collection",
        release: "reservation_release",
      }[operation],
      operation === "collect" ? -value : 0,
      before,
      after,
      String(request),
      reason,
    ]
  );
}
export async function reserveFee(user, request, type, value, c) {
  amount(value);
  const wallet = (
    await c.query("SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE", [user])
  ).rows[0];
  if (!wallet || wallet.balance - wallet.reserved < value)
    throw new WorkflowError("Insufficient available wallet funds", 402);
  const old = (
    await c.query(
      "SELECT id FROM reservations WHERE user_id=$1 AND repair_request_id=$2 AND fee_type=$3 AND status IN ('reserved','collected')",
      [user, request, type]
    )
  ).rows[0];
  if (old) throw new WorkflowError("Fee already reserved");
  const r = (
    await c.query(
      "INSERT INTO reservations(user_id,repair_request_id,reservation_type,fee_type,amount,status) VALUES($1,$2,'connection_fee',$3,$4,'reserved') RETURNING *",
      [user, request, type, value]
    )
  ).rows[0];
  await c.query("UPDATE wallets SET reserved=reserved+$1 WHERE user_id=$2", [
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
    "Connection fee reserved"
  );
  return r;
}
export async function releaseFee(id, reason, c) {
  const r = (
    await c.query("SELECT * FROM reservations WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (!r || r.status !== "reserved") return false;
  const w = (
    await c.query("SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE", [
      r.user_id,
    ])
  ).rows[0];
  if (w.reserved < r.amount)
    throw new WorkflowError("Wallet reservation mismatch");
  await c.query("UPDATE wallets SET reserved=reserved-$1 WHERE user_id=$2", [
    r.amount,
    r.user_id,
  ]);
  await c.query(
    "UPDATE reservations SET status='released',released_at=CURRENT_TIMESTAMP,release_reason=$1 WHERE id=$2",
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
    reason
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
    "SELECT id FROM reservations WHERE repair_request_id=$1 AND status='reserved' AND ($2::int IS NULL OR user_id<>$2) ORDER BY user_id,id",
    [request, exceptUser]
  );
  for (const r of rows) await releaseFee(r.id, reason, c);
}
export async function collectFees(journeyId, driver, mechanic, c) {
  const j = (
    await c.query("SELECT * FROM journeys WHERE id=$1 FOR UPDATE", [journeyId])
  ).rows[0];
  if (j.both_fees_collected) return { alreadyCollected: true };
  if (j.status !== "both_arrived")
    throw new WorkflowError("Verified arrival required");
  const rs = (
    await c.query(
      "SELECT * FROM reservations WHERE repair_request_id=$1 AND user_id IN ($2,$3) AND status='reserved' ORDER BY user_id FOR UPDATE",
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
    throw new WorkflowError("Both connection fee reservations are required");
  for (const r of rs) {
    const w = (
      await c.query("SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE", [
        r.user_id,
      ])
    ).rows[0];
    if (w.reserved < r.amount || w.balance < r.amount)
      throw new WorkflowError("Wallet reservation mismatch");
    await c.query(
      "UPDATE wallets SET balance=balance-$1,reserved=reserved-$1 WHERE user_id=$2",
      [r.amount, r.user_id]
    );
    await c.query(
      "UPDATE reservations SET status='collected',collected_at=CURRENT_TIMESTAMP WHERE id=$1",
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
      "Collected after verified mechanic GPS arrival"
    );
  }
  await c.query(
    "UPDATE journeys SET both_fees_collected=TRUE,both_fees_collected_at=CURRENT_TIMESTAMP,connection_fee_collected=TRUE WHERE id=$1",
    [j.id]
  );
  return { totalCollected: rs.reduce((s, r) => s + r.amount, 0) };
}
