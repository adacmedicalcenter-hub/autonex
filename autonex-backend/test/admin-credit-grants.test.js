import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import {createApp} from '../src/app.js';
process.env.APP_ENV='test';
process.env.JWT_SECRET='admin-credit-tests-secret-at-least-32-characters';
test('Administrator complimentary credits are authorised, atomic and retry safe',async t=>{
 const db=new PGlite();await db.waitReady;
 for(const name of (await fs.readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.exec(await fs.readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 let tail=Promise.resolve();const pool={query:(s,p)=>db.query(s,p),connect:async()=>{const old=tail;let release;tail=new Promise(r=>release=r);await old;return {query:(s,p)=>db.query(s,p),release};}};
 const server=createApp(pool).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const api=async(path,body,user,status=200)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;};
 const signup=(role,n)=>api('/auth/register',{user_type:role,full_name:'Grant user '+n,phone_number:'69100000'+n,password:'PasswordStrong1!',termsAccepted:true,termsVersion:'2026-10-15'});
 try{
 const driver=await signup('driver',1),mechanic=await signup('mechanic',2),admin=await signup('driver',3);
 await db.query('UPDATE users SET is_admin=TRUE WHERE id=$1',[admin.userId]);
 const path=u=>'/admin/users/'+u.userId+'/credits';
 const grant={credits:20,reason:'Pilot testing assistance',reference:'admin_1234567890123456'};
 await t.test('Only admins can grant; inputs and account eligibility are enforced',async()=>{
  await api(path(driver),grant,null,401);await api(path(driver),grant,driver,403);
  for(const credits of [0,-1,1.5,10001,'20'])await api(path(driver),{...grant,credits},admin,400);
  await api(path(driver),{...grant,reason:'x'},admin,400);
  await api(path(admin),grant,admin,403);
  await db.query('UPDATE users SET suspended=TRUE WHERE id=$1',[mechanic.userId]);await api(path(mechanic),grant,admin,403);
  await db.query('UPDATE users SET suspended=FALSE,is_active=FALSE WHERE id=$1',[mechanic.userId]);await api(path(mechanic),grant,admin,403);
  await db.query('UPDATE users SET is_active=TRUE WHERE id=$1',[mechanic.userId]);
 });
 await t.test('Simultaneous retries grant once, preserve reservations and record balance history',async()=>{
  await db.query('UPDATE connection_credit_accounts SET reserved=10 WHERE user_id=$1',[driver.userId]);
  const results=await Promise.all([api(path(driver),grant,admin),api(path(driver),grant,admin)]);
  assert.equal(results.filter(r=>r.duplicate).length,1);assert.equal(results[0].transaction.id,results[1].transaction.id);
  const w=(await db.query('SELECT * FROM connection_credit_accounts WHERE user_id=$1',[driver.userId])).rows[0];assert.equal(w.balance,40);assert.equal(w.reserved,10);
  assert.equal(results[0].transaction.balance_before,20);assert.equal(results[0].transaction.balance_after,40);
  await api(path(mechanic),grant,admin,409);await api(path(driver),{...grant,credits:30},admin,409);
 });
 await t.test('Mechanics receive credits and distinct simultaneous grants both persist',async()=>{
  await Promise.all([api(path(mechanic),{...grant,reference:'admin_mechanic_1234567890'},admin),api(path(mechanic),{...grant,reference:'admin_mechanic_9876543210'},admin)]);
  assert.equal((await api('/credits',null,mechanic)).balance,60);
 });
 await t.test('Audit failure rolls back the grant, ledger and balance; same reference can retry',async()=>{
  await db.exec("CREATE FUNCTION reject_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='grant_connection_credits' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_grant_audit BEFORE INSERT ON admin_audit FOR EACH ROW EXECUTE FUNCTION reject_grant_audit();");
  const body={...grant,reference:'admin_rollback_1234567890'};
  await api(path(driver),body,admin,500);assert.equal((await api('/credits',null,driver)).balance,40);
  assert.equal((await db.query('SELECT * FROM admin_credit_grants WHERE reference=$1',[body.reference])).rows.length,0);
  await db.exec('DROP TRIGGER reject_grant_audit ON admin_audit');await api(path(driver),body,admin);
 });
 await t.test('Reports show free grants separately and never as cash revenue',async()=>{
  const month=new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Douala'}).slice(0,7);
  const report=await api('/admin/monthly-report?month='+month,null,admin);
  assert.equal(report.summary.adminGrantedCredits,80);assert.equal(report.summary.realSalesXaf,0);
  const audits=await db.query("SELECT * FROM admin_audit WHERE action='grant_connection_credits'");assert.equal(audits.rows.length,4);
  const history=await api('/credits/transactions',null,driver);
  assert.ok(JSON.stringify(history).includes('admin_grant'));
 });
 }finally{await new Promise(r=>server.close(r));await db.close();}
});
