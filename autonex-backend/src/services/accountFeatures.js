import {adminCreditGrants} from './adminCreditGrants.js';
import {smsRecovery} from './smsRecovery.js';
import {createHash,randomBytes} from 'node:crypto';
import {WorkflowError} from './feeService.js';
import {cameroonPhone} from './creditService.js';
const digest=s=>createHash('sha256').update(s).digest('hex');
export function accountFeatures({route,pool,tx,auth,admin}) {
 smsRecovery({route,pool,tx});
 adminCreditGrants({route,tx,auth,admin});
 route('post','/api/admin/users/:id/status',req=>tx(async c=>{
  const {action,reason}=req.body;
  if(!['block','unblock','deactivate','reactivate'].includes(action)||!String(reason||'').trim())throw new WorkflowError('Choose an action and give a reason',400);
  const u=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
  if(!u)throw new WorkflowError('Account not found',404);
  if(u.is_admin)throw new WorkflowError('Admin accounts cannot be changed here',403);
  if(['block','deactivate'].includes(action))await c.query('UPDATE users SET availability=FALSE,auth_version=auth_version+1 WHERE id=$1',[u.id]);
  if(['block','unblock'].includes(action))await c.query('UPDATE users SET suspended=$1,suspend_until=NULL,suspend_reason=$2 WHERE id=$3',[action==='block',reason,u.id]);
  else await c.query('UPDATE users SET is_active=$1 WHERE id=$2',[action==='reactivate',u.id]);
  await c.query('INSERT INTO admin_audit(admin_id,action,details) VALUES($1,$2,$3)',[req.user.id,action,JSON.stringify({userId:u.id,reason})]);
  return {updated:true};
 }),auth,admin);
 // Recovery requires an administrator to verify ownership outside the app first.
 // No recovery code is issued merely on knowing another person's phone number.
 route('post','/api/admin/users/:id/recovery',req=>tx(async c=>{
  if(req.body.ownershipVerified!==true||String(req.body.reason||'').trim().length<10)throw new WorkflowError('Verify account ownership and record the verification method',400);
  const u=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
  if(!u||u.is_admin||!u.is_active||u.suspended)throw new WorkflowError('Account is not eligible for recovery',403);
  const code=randomBytes(24).toString('hex');
  await c.query(`INSERT INTO account_recovery_codes(user_id,code_hash,expires_at,created_by) VALUES($1,$2,now()+INTERVAL '15 minutes',$3)
   ON CONFLICT(user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,created_by=EXCLUDED.created_by,used_at=NULL`,[u.id,digest(code),req.user.id]);
  await c.query("INSERT INTO admin_audit(admin_id,action,details) VALUES($1,'issue_recovery',$2)",[req.user.id,JSON.stringify({userId:u.id,reason:req.body.reason})]);
  return {code,phone:u.phone_number,expiresInMinutes:15};
 }),auth,admin);
 route('post','/api/auth/recover',req=>tx(async c=>{
  const phone=cameroonPhone(req.body.phone_number);
  if(typeof req.body.password!=='string'||req.body.password.length<8||req.body.password.length>128||!/^\w{48}$/.test(req.body.code||''))throw new WorkflowError('Invalid recovery details',400);
  const u=(await c.query('SELECT * FROM users WHERE phone_number=$1 FOR UPDATE',[phone])).rows[0];
  if(!u||!u.is_active||u.suspended)throw new WorkflowError('Invalid or expired recovery code',400);
  const code=(await c.query('SELECT * FROM account_recovery_codes WHERE user_id=$1 FOR UPDATE',[u.id])).rows[0];
  if(!code||code.used_at||new Date(code.expires_at)<=new Date()||digest(req.body.code)!==code.code_hash)throw new WorkflowError('Invalid or expired recovery code',400);
  const {default:bcrypt}=await import('bcryptjs');
  await c.query('UPDATE users SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2',[await bcrypt.hash(req.body.password,10),u.id]);
  await c.query('UPDATE account_recovery_codes SET used_at=now() WHERE user_id=$1',[u.id]);
  await c.query('DELETE FROM push_devices WHERE user_id=$1',[u.id]);
  return {recovered:true};
 }));
 route('get','/api/history',async req=>{
  const journeys=(await pool.query(`SELECT id,connection_reference,status,created_at,'journey' AS kind FROM journeys j
   WHERE (driver_id=$1 OR mechanic_id=$1) AND status IN ('completed','cancelled','expired')
   AND NOT EXISTS(SELECT 1 FROM hidden_task_history h WHERE h.user_id=$1 AND h.kind='journey' AND h.task_id=j.id) ORDER BY id DESC`,[req.user.id])).rows;
  const requests=req.user.user_type==='driver'?(await pool.query(`SELECT id,title,status,created_at,'request' AS kind FROM repair_requests r
   WHERE driver_id=$1 AND status IN ('completed','cancelled','expired') AND NOT EXISTS(SELECT 1 FROM journeys j WHERE j.repair_request_id=r.id) AND NOT EXISTS(SELECT 1 FROM hidden_task_history h WHERE h.user_id=$1 AND h.kind='request' AND h.task_id=r.id) ORDER BY id DESC`,[req.user.id])).rows:[];
  return [...journeys,...requests];
 },auth);
 route('post','/api/history/hide',req=>tx(async c=>{
  const {kind,id}=req.body;
  if(!['request','journey'].includes(kind)||!Number.isSafeInteger(id))throw new WorkflowError('Invalid task',400);
  const q=kind==='request'?'SELECT * FROM repair_requests WHERE id=$1 FOR UPDATE':'SELECT * FROM journeys WHERE id=$1 FOR UPDATE';
  const row=(await c.query(q,[id])).rows[0];
  if(!row||(row.driver_id!==req.user.id&&row.mechanic_id!==req.user.id))throw new WorkflowError('Task access denied',403);
  if(!['completed','cancelled','expired'].includes(row.status))throw new WorkflowError('Only finished tasks may be removed from history',409);
  await c.query('INSERT INTO hidden_task_history(user_id,kind,task_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[req.user.id,kind,id]);
  if(kind==='journey'&&row.driver_id===req.user.id)await c.query("INSERT INTO hidden_task_history(user_id,kind,task_id) VALUES($1,'request',$2) ON CONFLICT DO NOTHING",[req.user.id,row.repair_request_id]);
  return {hidden:true};
 }),auth);
 route('get','/api/admin/monthly-report',async req=>{
  const month=String(req.query.month||'');
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw new WorkflowError('Choose a report month YYYY-MM',400);
  const start=month+'-01T00:00:00+01:00';
  const period="created_at >= $1::timestamptz AND created_at < (($1::timestamptz AT TIME ZONE 'Africa/Douala') + INTERVAL '1 month') AT TIME ZONE 'Africa/Douala'";
  // Explicit fields: no passwords, tokens, private ID documents or voice recordings.
  const users=(await pool.query('SELECT id,full_name,phone_number,user_type,is_active,suspended,is_demo,created_at FROM users WHERE '+period+' ORDER BY id',[start])).rows;
  const journeys=(await pool.query('SELECT id,connection_reference,driver_id,mechanic_id,status,created_at FROM journeys WHERE '+period+' ORDER BY id',[start])).rows;
  const transactions=(await pool.query('SELECT * FROM connection_credit_transactions WHERE '+period+' ORDER BY id',[start])).rows;
  const requests=(await pool.query('SELECT id,driver_id,title,vehicle_type,location,status,created_at FROM repair_requests WHERE '+period+' ORDER BY id',[start])).rows;
  const purchases=(await pool.query('SELECT * FROM connection_credit_purchases WHERE '+period+' ORDER BY created_at',[start])).rows;
  const summary={adminGrantedCredits:transactions.filter(t=>t.transaction_type==='admin_grant').reduce((a,t)=>a+t.amount,0),adRewardCredits:transactions.filter(t=>t.transaction_type==='ad_reward'&&t.source==='admob').reduce((a,t)=>a+t.amount,0),testAdRewardCredits:transactions.filter(t=>t.transaction_type==='ad_reward'&&t.source==='ad_test').reduce((a,t)=>a+t.amount,0),newUsers:users.length,requestsCreated:requests.length,connectionsCreated:journeys.length,creditsCharged:transactions.filter(t=>t.transaction_type==='fee_collection').reduce((a,t)=>a-t.amount,0),creditsRefunded:transactions.filter(t=>t.transaction_type==='refund').reduce((a,t)=>a+t.amount,0),realSalesXaf:purchases.filter(p=>p.status==='paid'&&p.provider!=='test').reduce((a,p)=>a+p.amount_xaf,0),simulatedSalesXaf:purchases.filter(p=>p.status==='paid'&&p.provider==='test').reduce((a,p)=>a+p.amount_xaf,0)};
  await pool.query("INSERT INTO admin_audit(admin_id,action,details) VALUES($1,'export_monthly_report',$2)",[req.user.id,JSON.stringify({month})]);
  return {month,timezone:'Africa/Douala',generatedAt:new Date().toISOString(),summary,users,requests,journeys,transactions,purchases};
 },auth,admin);
}
