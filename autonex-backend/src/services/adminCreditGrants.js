import {WorkflowError} from './feeService.js';

// Grant, balance update, ledger and administrator audit commit together.
export function adminCreditGrants({route,tx,auth,admin}) {
 route('post','/api/admin/users/:id/credits',req=>tx(async c=>{
  const userId=Number(req.params.id);
  const {credits,reference}=req.body;
  const reason=typeof req.body.reason==='string'?req.body.reason.trim():'';
  if(!Number.isSafeInteger(userId)||userId<1||!Number.isSafeInteger(credits)||credits<1||credits>10000||reason.length<5||reason.length>500||typeof reference!=='string'||!/^admin_[A-Za-z0-9_-]{16,100}$/.test(reference))
   throw new WorkflowError('Use 1–10,000 whole credits, a reason of 5–500 characters and a valid grant reference',400);
  const user=(await c.query('SELECT id,is_admin,is_active,suspended FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
  if(!user)throw new WorkflowError('Account not found',404);
  if(user.is_admin||!user.is_active||user.suspended)throw new WorkflowError('Choose an active, unblocked driver or mechanic account',403);
  const inserted=await c.query('INSERT INTO admin_credit_grants(reference,user_id,admin_id,credits,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reference) DO NOTHING RETURNING reference',[reference,userId,req.user.id,credits,reason]);
  if(!inserted.rows.length){
   const old=(await c.query('SELECT * FROM admin_credit_grants WHERE reference=$1',[reference])).rows[0];
   if(old.user_id!==userId||old.admin_id!==req.user.id||old.credits!==credits||old.reason!==reason)throw new WorkflowError('This grant reference has already been used for different details',409);
   const transaction=(await c.query("SELECT * FROM connection_credit_transactions WHERE user_id=$1 AND transaction_type='admin_grant' AND reference_id=$2",[userId,reference])).rows[0];
   return {duplicate:true,transaction};
  }
  await c.query('INSERT INTO connection_credit_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
  const wallet=(await c.query('SELECT * FROM connection_credit_accounts WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
  if(wallet.balance>2147483647-credits)throw new WorkflowError('Credit balance limit exceeded',409);
  await c.query('UPDATE connection_credit_accounts SET balance=balance+$1 WHERE user_id=$2',[credits,userId]);
  const transaction=(await c.query("INSERT INTO connection_credit_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description) VALUES($1,'admin_grant',$2,$3,$4,'admin',$5,$6) RETURNING *",[userId,credits,wallet.balance,wallet.balance+credits,reference,reason])).rows[0];
  await c.query("INSERT INTO admin_audit(admin_id,action,details) VALUES($1,'grant_connection_credits',$2)",[req.user.id,JSON.stringify({userId,credits,reason,reference,transactionId:transaction.id})]);
  return {duplicate:false,transaction};
 }),auth,admin);
}
