import {WorkflowError} from './feeService.js';
export const packages=Object.freeze([
 {id:'starter',name:'Starter',priceXaf:2000,credits:20},
 {id:'standard',name:'Standard',priceXaf:3000,credits:40},
 {id:'professional',name:'Professional',priceXaf:5000,credits:60}
]);
// Only call after trusted provider verification, or inside the explicit test-only route.
export async function completePurchase(c,user,packageId,reference,provider) {
 const pack=packages.find(p=>p.id===packageId);
 if(!pack||typeof reference!=='string'||!/^[-a-zA-Z0-9_]{8,150}$/.test(reference))throw new WorkflowError('Invalid package or payment reference',400);
 await c.query('INSERT INTO connection_credit_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING',[user]);
 const w=(await c.query('SELECT * FROM connection_credit_accounts WHERE user_id=$1 FOR UPDATE',[user])).rows[0];
 // Global uniqueness also prevents one receipt being used on two accounts.
 const inserted=(await c.query(`INSERT INTO connection_credit_purchases(reference,user_id,package_id,amount_xaf,credits,provider,status)
 VALUES($1,$2,$3,$4,$5,$6,'paid') ON CONFLICT(reference) DO NOTHING RETURNING reference`,[reference,user,pack.id,pack.priceXaf,pack.credits,provider])).rows;
 if(!inserted.length){
  const old=(await c.query('SELECT * FROM connection_credit_purchases WHERE reference=$1',[reference])).rows[0];
  if(old.user_id!==user||old.package_id!==pack.id||old.provider!==provider||old.status!=='paid')throw new WorkflowError('Payment reference already used');
  return {duplicate:true,balance:w.balance,simulated:provider==='test'};
 }
 await c.query('UPDATE connection_credit_accounts SET balance=balance+$1 WHERE user_id=$2',[pack.credits,user]);
 await c.query(`INSERT INTO connection_credit_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description)
 VALUES($1,'purchase',$2,$3,$4,$5,$6,$7)`,[user,pack.credits,w.balance,w.balance+pack.credits,provider,reference,pack.name+' connection package']);
 return {duplicate:false,balance:w.balance+pack.credits,simulated:provider==='test'};
}
export function cameroonPhone(value) {
 const input=String(value||'').trim().replace(/[\s()-]/g,'');
 const local=input.startsWith('+237')?input.slice(4):input;
 if(!/^[26]\d{8}$/.test(local))throw new WorkflowError('Enter your 9-digit Cameroon phone number',400);
 return '+237'+local;
}
