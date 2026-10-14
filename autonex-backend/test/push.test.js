import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import {createApp} from '../src/app.js';
import {queueRequestAlerts,drainPush,firebaseSender,pushRadius} from '../src/services/pushService.js';
process.env.TZ='UTC';
process.env.JWT_SECRET='test-only-jwt-with-at-least-32-characters';
process.env.PIN_SECRET='test-only-separate-pin-with-at-least-32-characters';
process.env.APP_ENV='test';
test('Push routing, authorization and durable queue',async t=> {
 const db=new PGlite();await db.waitReady;
 for(const file of (await fs.readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())
  await db.exec(await fs.readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 let tail=Promise.resolve();
 const pool={query:(s,p)=>db.query(s,p),connect:async()=>{const previous=tail;let release;tail=new Promise(r=>release=r);await previous;return {query:(s,p)=>db.query(s,p),release};}};
 const server=createApp(pool,{pushEnabled:true}).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 const api=async(method,path,body,user,status=200)=> {
  const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;
 };
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
 const reg=async(role,n)=>api('POST','/api/auth/register',{user_type:role,full_name:'Push Tester',phone_number:'+23761111111'+n,password:'PushTestPassword'});
 try {
 const driver=await reg('driver',1), near=await reg('mechanic',2), far=await reg('mechanic',3), stale=await reg('mechanic',4);
 const unavailable=await reg('mechanic',5), suspended=await reg('mechanic',6);
 await db.query("UPDATE users SET mechanic_review_status='approved' WHERE user_type='mechanic'");
 const profile={availability:true,latitude:4.075,longitude:9.675};
 for(const [i,user] of [near,far,stale].entries()) {
  await api('PATCH','/api/users/profile',{...profile,latitude:user===far?4.135:4.1},user);
  await api('POST','/api/notifications/device',{installationId:ids[i],token:'fake-token-for-push-test-'+i},user);
 }
 for(const [i,user] of [unavailable,suspended].entries()) {
  const id=`44444444-4444-4444-8444-44444444444${i}`;
  await api('PATCH','/api/users/profile',profile,user);
  await api('POST','/api/notifications/device',{installationId:id,token:'fake-token-for-excluded-'+i},user);
 }
 await db.query('UPDATE users SET availability=FALSE WHERE id=$1',[unavailable.userId]);
 await db.query('UPDATE users SET suspended=TRUE WHERE id=$1',[suspended.userId]);
 await db.query("UPDATE users SET location_updated_at=CURRENT_TIMESTAMP-INTERVAL '25 hours' WHERE id=$1",[stale.userId]);
 let request;
 await t.test('GPS search returns available mechanics within 5 km even after five minutes',async()=> {
  await db.query("UPDATE users SET location_updated_at=CURRENT_TIMESTAMP-INTERVAL '6 hours' WHERE id=$1",[near.userId]);
  const results=await api('GET','/api/mechanics/available?latitude=4.075&longitude=9.675',null,driver);
  assert.deepEqual(results.map(x=>x.id),[near.userId]);
  assert.ok(results[0].distance_m<5000);
  await api('GET','/api/mechanics/available?latitude=oops&longitude=9.675',null,driver,400);
 });
 await t.test('device routes require authentication and valid IDs',async()=> {
  await api('POST','/api/notifications/device',{installationId:ids[0],token:'fake-token-for-push-test-0'},null,401);
  await api('POST','/api/notifications/device',{installationId:'bad',token:'fake-token-for-push-test-0'},near,400);
  await api('POST','/api/notifications/device',{installationId:ids[0],token:'short'},near,400);
 });
 await t.test('5 km radius includes a mechanic at 2.8 km and excludes one at 6.7 km',async()=> {
  request=await api('POST','/api/repair-requests',{title:'Engine failure',location:'Bonaberi',latitude:4.075,longitude:9.675},driver);
  assert.equal(request.notificationsQueued,1);
  const rows=(await db.query('SELECT * FROM push_outbox')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].user_id,near.userId);
  assert.equal(pushRadius(),5000);
  assert.equal(await queueRequestAlerts(pool,request),0);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM push_outbox')).rows[0].n,1);
 });
 await t.test('queue failure rolls back request and wallet reservation',async()=> {
  const count=(await db.query('SELECT COUNT(*)::int AS n FROM repair_requests')).rows[0].n;
  const wallet=(await db.query('SELECT balance,reserved FROM wallets WHERE user_id=$1',[driver.userId])).rows[0];
  await db.exec('ALTER TABLE push_outbox RENAME TO push_outbox_hidden');
  await api('POST','/api/repair-requests',{title:'Rollback test',location:'Bonaberi',latitude:4.075,longitude:9.675},driver,500);
  await db.exec('ALTER TABLE push_outbox_hidden RENAME TO push_outbox');
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM repair_requests')).rows[0].n,count);
  assert.deepEqual((await db.query('SELECT balance,reserved FROM wallets WHERE user_id=$1',[driver.userId])).rows[0],wallet);
 });
 await t.test('failed delivery retries; successful payload has no personal data',async()=> {
  await drainPush(pool,async()=>{const e=new Error('private text must not be saved');e.code='messaging/server-unavailable';throw e;});
  const row=(await db.query('SELECT * FROM push_outbox')).rows[0];
  assert.equal(row.status,'pending');assert.equal(row.attempts,1);assert.equal(row.last_error,'messaging/server-unavailable');
  await db.exec('UPDATE push_outbox SET next_attempt_at=CURRENT_TIMESTAMP');
  const sent=[];await drainPush(pool,async m=>sent.push(m));
  assert.equal(sent.length,1);assert.equal(sent[0].android.notification.channelId,'autonex_requests');
  assert.equal(sent[0].data.requestId,String(request.id));
  assert.equal(sent[0].notification.body.includes('Bonaberi'),false);
  assert.equal((await db.query('SELECT status FROM push_outbox')).rows[0].status,'sent');
  await drainPush(pool,async m=>sent.push(m));assert.equal(sent.length,1);
 });
 await t.test('cancelled request never sends a pending alert',async()=> {
  await db.exec("UPDATE push_outbox SET status='pending'");
  await api('DELETE','/api/repair-requests/'+request.id,null,driver);
  let sends=0;await drainPush(pool,async()=>sends++);assert.equal(sends,0);
  assert.equal((await db.query('SELECT status FROM push_outbox')).rows[0].status,'skipped');
 });
 await t.test('self test rate limit and unavailable or expired recipient checks',async()=> {
  await api('POST','/api/notifications/test',{},near);await api('POST','/api/notifications/test',{},near);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM push_outbox WHERE kind='test'")).rows[0].n,1);
  await db.exec("UPDATE push_outbox SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE kind='test'");
  let sends=0;await drainPush(pool,async()=>sends++);assert.equal(sends,0);
 });
 await t.test('logout ownership prevents another account from deleting a phone',async()=> {
  await api('DELETE','/api/notifications/device',{installationId:ids[0]},driver);
  assert.equal((await api('GET','/api/notifications/status',null,near)).devices,1);
 });
 await t.test('account switch prevents pending alerts for previous owner',async()=> {
  await db.exec("UPDATE push_outbox SET status='pending',expires_at=CURRENT_TIMESTAMP+INTERVAL '5 minutes' WHERE kind='test'");
  await api('POST','/api/notifications/device',{installationId:ids[0],token:'fake-token-for-push-test-0'},driver);
  let sends=0;await drainPush(pool,async()=>sends++);assert.equal(sends,0);
 });
 await t.test('invalid Firebase token is removed, and logout removes device',async()=> {
  await api('POST','/api/notifications/test',{},driver);
  await drainPush(pool,async()=>{const e=new Error();e.code='messaging/registration-token-not-registered';throw e;});
  assert.equal((await api('GET','/api/notifications/status',null,driver)).devices,0);
  await api('DELETE','/api/notifications/device',{installationId:ids[1]},far);
  assert.equal((await api('GET','/api/notifications/status',null,far)).devices,0);
 });
 await t.test('credentials errors never disclose submitted key content',async()=> {
  assert.equal(await firebaseSender(''),null);
  await assert.rejects(firebaseSender('secret-invalid-json'),/must contain valid JSON/);
  await assert.rejects(firebaseSender(JSON.stringify({project_id:'wrong',private_key:'secret'})),/RESQUORA test project/);
 });
 } finally {await new Promise(r=>server.close(r));await db.close();}
});
