import {randomBytes} from 'node:crypto';
import {packages,completePurchase} from './creditService.js';
import {WorkflowError} from './feeService.js';
export function manualPaymentMethods(){if(process.env.MANUAL_PAYMENTS_ENABLED==='false')return [];
 return [
 {id:'mtn_momo',name:'MTN MoMo',recipient:'Sanche Julius Ngenge',number:'+237675804523'},
 {id:'orange_money',name:'Orange Money',recipient:'Sanche Julius Ngenge',number:'+237656304750'},
 {id:'bank_transfer',name:'Bank transfer',recipient:'Sanche Julius Ngenge',bank:'Afriland First Bank — Cameroon',accountNumber:'10005 00027 00000209736 29',iban:'CM21 10005 00027 00000209736 29',swift:'CCEICMCX'}];}
export function manualPayments({route,pool,tx,auth,admin}){
 route('get','/api/credits/payment-methods',async()=>({methods:manualPaymentMethods(),confirmation:'manual'}),auth);
 route('get','/api/credits/payment-orders',async req=>(await pool.query('SELECT id,package_id,amount_xaf,credits,method,status,customer_reference,review_note,created_at FROM manual_package_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',[req.user.id])).rows,auth);
 route('post','/api/credits/payment-orders',req=>tx(async c=>{
  await c.query('LOCK TABLE manual_package_orders IN SHARE ROW EXCLUSIVE MODE');
  const pack=packages.find(p=>p.id===req.body.packageId),method=manualPaymentMethods().find(p=>p.id===req.body.method),key=String(req.body.reference||'');
  if(!pack||!method||!/^[-a-zA-Z0-9_]{8,150}$/.test(key))throw new WorkflowError('Invalid package or payment method',400);
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
  const existing=(await c.query('SELECT * FROM manual_package_orders WHERE user_id=$1 AND client_key=$2',[req.user.id,key])).rows[0];
  if(existing){if(existing.package_id!==pack.id||existing.method!==method.id)throw new WorkflowError('Payment request already used',409);return existing;}
  if((await c.query("SELECT COUNT(*)::int AS n FROM manual_package_orders WHERE user_id=$1 AND status IN ('awaiting_payment','submitted')",[req.user.id])).rows[0].n>=10)throw new WorkflowError('You already have pending payments. Review them before creating another.',409);
  return (await c.query('INSERT INTO manual_package_orders(id,user_id,client_key,package_id,amount_xaf,credits,method) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',['PAY-'+randomBytes(12).toString('hex').toUpperCase(),req.user.id,key,pack.id,pack.priceXaf,pack.credits,method.id])).rows[0];
 }),auth);
 route('post','/api/credits/payment-orders/:id/submit',req=>tx(async c=>{
  await c.query('LOCK TABLE manual_package_orders IN SHARE ROW EXCLUSIVE MODE');
  const row=(await c.query('SELECT * FROM manual_package_orders WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
  if(!row||row.user_id!==req.user.id)throw new WorkflowError('Payment not found',404);
  if(row.status==='submitted'||row.status==='approved')return {status:row.status};
  if(row.status!=='awaiting_payment')throw new WorkflowError('Payment is already closed',409);
  const reference=String(req.body.paymentReference||'').trim();if(reference.length<4||reference.length>120)throw new WorkflowError('Enter the transaction reference shown on your payment receipt',400);
  await c.query("UPDATE manual_package_orders SET status='submitted',customer_reference=$1,submitted_at=now() WHERE id=$2",[reference,row.id]);return {status:'submitted'};
 }),auth);
 route('get','/api/admin/payment-orders',async req=>{
  const offset=Math.max(0,Math.min(10000000,parseInt(req.query.offset,10)||0));
  const total=(await pool.query('SELECT COUNT(*)::int AS n FROM manual_package_orders')).rows[0].n;
  return {total,orders:(await pool.query('SELECT o.*,u.full_name,u.phone_number FROM manual_package_orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 100 OFFSET $1',[offset])).rows};
 },auth,admin);
 route('post','/api/admin/payment-orders/:id/review',req=>tx(async c=>{
  await c.query('LOCK TABLE manual_package_orders IN SHARE ROW EXCLUSIVE MODE');
  const row=(await c.query('SELECT * FROM manual_package_orders WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
  if(!row)throw new WorkflowError('Payment not found',404);
  const {decision}=req.body;
  if(!['approve','reject'].includes(decision))throw new WorkflowError('Choose approve or reject',400);
  if(row.status==='approved'&&decision==='approve')return {status:'approved',duplicate:true};
  if(row.status==='rejected'&&decision==='reject')return {status:'rejected',duplicate:true};
  if(!['submitted','awaiting_payment'].includes(row.status))throw new WorkflowError('Payment is already closed',409);
  const note=String(req.body.note||'').trim();if(note.length<5||note.length>1000)throw new WorkflowError('Record the payment verification or rejection reason',400);
  if(decision==='approve'){
   if(req.body.receivedVerified!==true||Number(req.body.receivedAmountXaf)!==row.amount_xaf)throw new WorkflowError('Verify receipt in your account and the exact package amount',400);
   const receipt=String(req.body.providerReference||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
   if(receipt.length<4||receipt.length>120)throw new WorkflowError('Enter the verified provider transaction reference',400);
   // A global lock serializes receipt checks even when different accounts submit the same receipt.
   if((await c.query('SELECT id FROM manual_package_orders WHERE method=$1 AND provider_reference=$2 AND id<>$3',[row.method,receipt,row.id])).rows.length)throw new WorkflowError('This provider transaction has already been credited',409);
   const pack=packages.find(p=>p.id===row.package_id);if(!pack||pack.priceXaf!==row.amount_xaf||pack.credits!==row.credits)throw new WorkflowError('Package changed. Review this payment before crediting.',409);
   await completePurchase(c,row.user_id,row.package_id,row.id,'manual_'+row.method);
   await c.query("UPDATE manual_package_orders SET status='approved',provider_reference=$1,review_note=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$4",[receipt,note,req.user.id,row.id]);
  }else await c.query("UPDATE manual_package_orders SET status='rejected',review_note=$1,reviewed_by=$2,reviewed_at=now() WHERE id=$3",[note,req.user.id,row.id]);
  await c.query('INSERT INTO admin_audit(admin_id,action,details) VALUES($1,$2,$3)',[req.user.id,'manual_payment_'+decision,JSON.stringify({order:row.id,userId:row.user_id,amountXaf:row.amount_xaf,method:row.method,note})]);
  return {status:decision==='approve'?'approved':'rejected'};
 }),auth,admin);
}
