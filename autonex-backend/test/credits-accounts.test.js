import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import {createApp} from '../src/app.js';
process.env.APP_ENV='test';process.env.ALLOW_TEST_TOPUPS='true';
process.env.JWT_SECRET='account-tests-secret-at-least-32-characters';
test('Credit packages, account controls, recovery, reports and service editing',async t=>{
 const db=new PGlite();await db.waitReady;
 for(const name of (await fs.readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.exec(await fs.readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 let tail=Promise.resolve();const pool={query:(s,p)=>db.query(s,p),connect:async()=>{const old=tail;let release;tail=new Promise(r=>release=r);await old;return {query:(s,p)=>db.query(s,p),release};}};
 const server=createApp(pool).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const api=async(method,path,body,user,status=200)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;};
 const signup=(role,n,extra={})=>api('POST','/api/auth/register',{user_type:role,full_name:'Account '+n,phone_number:'69000000'+n,password:'PasswordStrong1!',termsAccepted:true,termsVersion:'2026-10-15',...extra});
 try{
  await t.test('Signup requires explicit agreement and normalizes nine-digit numbers',async()=>{
   await api('POST','/api/auth/register',{user_type:'driver',full_name:'Declined terms',phone_number:'690000000',password:'PasswordStrong1!',termsAccepted:false,termsVersion:'2026-10-15'},null,400);
   const missing=await api('POST','/api/auth/register',{user_type:'driver',full_name:'Missing terms',phone_number:'690000000',password:'PasswordStrong1!'},null,400);assert.match(missing.error,/terms/);
   await api('POST','/api/auth/login',{phone_number:'123',password:'x'},null,400);
  });
  const driver=await signup('driver',1),mechanic=await signup('mechanic',2),other=await signup('driver',3),admin=await signup('driver',4);
  await db.query('UPDATE users SET is_admin=TRUE WHERE id=$1',[admin.userId]);
  await db.query("UPDATE users SET mechanic_review_status='approved' WHERE id=$1",[mechanic.userId]);
  await t.test('Admin counts include drivers and role-filtered accounts remain searchable and paginated',async()=>{
   await api('GET','/api/admin/users?role=driver',null,driver,403);
   const stats=await api('GET','/api/admin/analytics/dashboard',null,admin);
   assert.equal(stats.totalUsers,4);assert.equal(stats.totalDrivers,2);assert.equal(stats.totalMechanics,1);assert.equal(stats.totalAdministrators,1);
   const drivers=await api('GET','/api/admin/users?role=driver',null,admin);
   assert.equal(drivers.total,2);assert.equal(drivers.users.length,2);assert.ok(drivers.users.every(u=>u.user_type==='driver'&&!u.is_admin));
   const searched=await api('GET','/api/admin/users?role=driver&search=690000001',null,admin);assert.equal(searched.total,1);assert.equal(searched.users[0].id,driver.userId);
   const end=await api('GET','/api/admin/users?role=driver&offset=2',null,admin);assert.equal(end.total,2);assert.deepEqual(end.users,[]);
   const all=await api('GET','/api/admin/users',null,admin);assert.equal(all.total,4);assert.ok(all.users.every(u=>!('password_hash' in u)));
  });
  await t.test('Free signup credits are 20 for both roles and login does not grant more',async()=>{
   for(const u of [driver,mechanic])assert.equal((await api('GET','/api/credits',null,u)).balance,20);
   await api('POST','/api/auth/login',{phone_number:'+237690000001',password:'PasswordStrong1!'});
   assert.equal((await api('GET','/api/credits',null,driver)).balance,20);
   assert.equal((await db.query('SELECT phone_number FROM users WHERE id=$1',[driver.userId])).rows[0].phone_number,'+237690000001');
   assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM signup_terms_acceptances')).rows[0].n,4);
  });
  await t.test('Packages have exact prices and duplicate receipts cannot credit twice or another user',async()=>{
   const catalog=await api('GET','/api/credits/packages',null,driver);assert.deepEqual(catalog.packages.map(p=>[p.priceXaf,p.credits]),[[2000,20],[3000,40],[5000,60]]);
   const body={packageId:'standard',reference:'same_receipt_123'};
   const results=await Promise.all([api('POST','/api/credits/purchases/test',body,driver),api('POST','/api/credits/purchases/test',body,driver)]);
   assert.equal(results.filter(r=>r.duplicate).length,1);assert.equal((await api('GET','/api/credits',null,driver)).balance,60);
   await api('POST','/api/credits/purchases/test',body,other,409);
   await api('POST','/api/credits/purchases/test',{...body,packageId:'starter'},driver,409);
   assert.equal((await api('GET','/api/admin/analytics/dashboard',null,admin)).totalRevenueXaf,0);
  });
  await t.test('Owner service endpoints reload all editable fields and reject another mechanic',async()=>{
   const s=await api('POST','/api/service-offers',{service_name:'Engine',specialization:'Diesel',location:'Bonaberi',availability:'Weekdays'},mechanic);
   assert.equal((await api('GET','/api/service-offers/mine',null,mechanic))[0].id,s.id);
   const loaded=await api('GET','/api/service-offers/'+s.id,null,mechanic);assert.equal(loaded.specialization,'Diesel');assert.equal(loaded.availability,'Weekdays');
   await api('PATCH','/api/service-offers/'+s.id,{service_name:'Engine repair',specialization:'Petrol',location:'Douala',availability:'Weekends'},mechanic);
   const edited=await api('GET','/api/service-offers/'+s.id,null,mechanic);assert.equal(edited.location,'Douala');assert.equal(edited.specialization,'Petrol');assert.equal(edited.availability,'Weekends');
   await api('GET','/api/service-offers/'+s.id,null,other,403);
  });
  await t.test('History removal is per user and preserves statistics',async()=>{
   const r=(await db.query("INSERT INTO repair_requests(driver_id,title,location,status) VALUES($1,'Cancelled demo','Douala','cancelled') RETURNING id",[driver.userId])).rows[0];
   const j=(await db.query("INSERT INTO journeys(repair_request_id,driver_id,mechanic_id,status) VALUES($1,$2,$3,'cancelled') RETURNING id",[r.id,driver.userId,mechanic.userId])).rows[0];
   await api('POST','/api/history/hide',{kind:'journey',id:j.id},other,403);
   await api('POST','/api/history/hide',{kind:'journey',id:j.id},mechanic);
   assert.equal((await api('GET','/api/history',null,mechanic)).length,0);
   assert.equal((await api('GET','/api/history',null,driver)).length,1);
   await api('POST','/api/history/hide',{kind:'request',id:r.id},driver);
   assert.equal((await api('GET','/api/repair-requests',null,driver)).some(x=>x.id===r.id),false);
   assert.equal((await api('GET','/api/admin/analytics/dashboard',null,admin)).totalJourneys,1);
  });
  await t.test('Blocks revoke existing sessions; deactivation prevents login',async()=>{
   await api('POST','/api/admin/users/'+other.userId+'/status',{action:'block',reason:'Demo block'},driver,403);
   await api('POST','/api/admin/users/'+other.userId+'/status',{action:'block',reason:'Demo block'},admin);
   await api('GET','/api/credits',null,other,401);
   await api('POST','/api/auth/login',{phone_number:'690000003',password:'PasswordStrong1!'},null,403);
   await api('POST','/api/admin/users/'+other.userId+'/status',{action:'unblock',reason:'Reviewed'},admin);
   await api('POST','/api/admin/users/'+other.userId+'/status',{action:'deactivate',reason:'Demo cancelled'},admin);
   await api('POST','/api/auth/login',{phone_number:'690000003',password:'PasswordStrong1!'},null,401);
   await api('POST','/api/admin/users/'+admin.userId+'/status',{action:'block',reason:'Test'},admin,403);
  });
  await t.test('Verified-owner recovery is single-use and invalidates old tokens',async()=>{
   await api('POST','/api/admin/users/'+driver.userId+'/recovery',{reason:'Phone ownership verified'},admin,400);
   const r=await api('POST','/api/admin/users/'+driver.userId+'/recovery',{ownershipVerified:true,reason:'Verified through established support channel'},admin);
   const body={phone_number:'690000001',code:r.code,password:'UpdatedPassword123!'};
   await api('POST','/api/auth/recover',{...body,code:'0'.repeat(48)},null,400);
   await api('POST','/api/auth/recover',body);
   await api('POST','/api/auth/recover',body,null,400);
   await api('GET','/api/credits',null,driver,401);
   await api('POST','/api/auth/login',{phone_number:'690000001',password:'PasswordStrong1!'},null,401);
   const fresh=await api('POST','/api/auth/login',{phone_number:'690000001',password:'UpdatedPassword123!'});
   assert.equal((await api('GET','/api/credits',null,fresh)).balance,60);
  });
  await t.test('Phone-first SMS recovery verifies provider codes once and revokes old sessions',async()=>{
   const user=await signup('driver',5);
   await api('POST','/api/auth/recovery/request',{phone_number:'690000005'},null,503);
   const originalFetch=globalThis.fetch;const sid='VE'+'b'.repeat(32);let sent=0;
   process.env.SMS_RECOVERY_ENABLED='true';process.env.TWILIO_ACCOUNT_SID='AC'+'a'.repeat(32);process.env.TWILIO_AUTH_TOKEN='test-only-secret';process.env.TWILIO_VERIFY_SERVICE_SID='VA'+'c'.repeat(32);
   globalThis.fetch=async(url,options)=>{if(!String(url).startsWith('https://verify.twilio.com/'))return originalFetch(url,options);
    const body=new URLSearchParams(options.body);if(String(url).endsWith('/Verifications')){sent++;assert.equal(body.get('To'),'+237690000005');return new Response(JSON.stringify({sid,status:'pending'}));}
    assert.equal(body.get('VerificationSid'),sid);return new Response(JSON.stringify({sid,status:body.get('Code')==='123456'?'approved':'pending'}));};
   try{
    const start=await api('POST','/api/auth/recovery/request',{phone_number:'690000005'});assert.equal(sent,1);assert.ok(start.requestId);assert.ok(!start.code);
    await api('POST','/api/auth/recovery/request',{phone_number:'690000005'},null,429);
    await api('POST','/api/auth/recovery/complete',{requestId:start.requestId,code:'000000',password:'NewPasswordStrong1!'},null,400);
    assert.equal((await db.query('SELECT attempts FROM sms_recovery_requests WHERE id=$1',[start.requestId])).rows[0].attempts,1);
    await api('POST','/api/auth/recovery/complete',{requestId:start.requestId,code:'123456',password:'NewPasswordStrong1!'});
    await api('POST','/api/auth/recovery/complete',{requestId:start.requestId,code:'123456',password:'AnotherPassword1!'},null,400);
    await api('GET','/api/credits',null,user,401);
    await api('POST','/api/auth/login',{phone_number:'690000005',password:'PasswordStrong1!'},null,401);
    await api('POST','/api/auth/login',{phone_number:'690000005',password:'NewPasswordStrong1!'});
    const absent=await api('POST','/api/auth/recovery/request',{phone_number:'690000009'});assert.equal(absent.message,start.message);assert.equal(sent,1);
    await api('POST','/api/auth/recovery/complete',{requestId:absent.requestId,code:'123456',password:'NewPasswordStrong1!'},null,400);
   }finally{globalThis.fetch=originalFetch;for(const k of ['SMS_RECOVERY_ENABLED','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_VERIFY_SERVICE_SID'])delete process.env[k];}
  });
  await t.test('Manual package payments require admin receipt verification and cannot credit a receipt twice',async()=>{
   const buyer=await api('POST','/api/auth/login',{phone_number:'690000005',password:'NewPasswordStrong1!'});
   const methods=await api('GET','/api/credits/payment-methods',null,buyer);assert.equal(methods.methods.length,3);
   const payload={packageId:'starter',method:'mtn_momo',reference:'manual_test_order_1'};
   const order=await api('POST','/api/credits/payment-orders',payload,buyer);
   assert.equal((await api('POST','/api/credits/payment-orders',payload,buyer)).id,order.id);
   const initial=(await api('GET','/api/credits',null,buyer)).balance;
   await api('POST','/api/credits/payment-orders/'+order.id+'/submit',{paymentReference:'customer-receipt'},mechanic,404);
   await api('POST','/api/credits/payment-orders/'+order.id+'/submit',{paymentReference:'customer-receipt'},buyer);
   assert.equal((await api('GET','/api/credits',null,buyer)).balance,initial);
   const review={decision:'approve',receivedVerified:true,receivedAmountXaf:2000,providerReference:'MTN-123456',note:'Verified in receiving MTN account'};
   await api('POST','/api/admin/payment-orders/'+order.id+'/review',review,buyer,403);
   await api('POST','/api/admin/payment-orders/'+order.id+'/review',{...review,receivedVerified:false},admin,400);
   await api('POST','/api/admin/payment-orders/'+order.id+'/review',{...review,receivedAmountXaf:3000},admin,400);
   await Promise.all([api('POST','/api/admin/payment-orders/'+order.id+'/review',review,admin),api('POST','/api/admin/payment-orders/'+order.id+'/review',review,admin)]);
   assert.equal((await api('GET','/api/credits',null,buyer)).balance,initial+20);
   const second=await api('POST','/api/credits/payment-orders',{...payload,reference:'manual_test_order_2'},buyer);
   await api('POST','/api/admin/payment-orders/'+second.id+'/review',{...review,providerReference:'mtn 123456'},admin,409);
   assert.equal((await api('GET','/api/credits',null,buyer)).balance,initial+20);
   await api('POST','/api/admin/payment-orders/'+second.id+'/review',{decision:'reject',note:'No separate payment received'},admin);
   await api('POST','/api/admin/payment-orders/'+second.id+'/review',review,admin,409);
   const owned=await api('GET','/api/credits/payment-orders',null,buyer);assert.equal(owned.length,2);
   assert.equal((await api('GET','/api/credits/payment-orders',null,mechanic)).length,0);
   assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM connection_credit_transactions WHERE reference_id=$1",[order.id])).rows[0].n,1);
  });
  await t.test('Monthly exports are complete safe data and separate test revenue',async()=>{
   const month=new Date().toISOString().slice(0,7);
   const report=await api('GET','/api/admin/monthly-report?month='+month,null,admin);
   assert.equal(report.summary.simulatedSalesXaf,3000);assert.equal(report.summary.realSalesXaf,2000);
   assert.equal(report.journeys.length,1);assert.equal(report.users.length,5);
   assert.equal(JSON.stringify(report).includes('password_hash'),false);
   await api('GET','/api/admin/monthly-report?month=2026-99',null,admin,400);
   await api('GET','/api/admin/monthly-report?month='+month,null,mechanic,403);
  });
 }finally{await new Promise(r=>server.close(r));await db.close();}
});
