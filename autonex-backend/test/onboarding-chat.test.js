import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/app.js';
import {drainPush,reconcileRequestAlerts} from '../src/services/pushService.js';
process.env.TZ='UTC';process.env.APP_ENV='test';process.env.PROFILE_SECRET='test-only-profile-secret-with-at-least-32-characters';process.env.JWT_SECRET='test-only-jwt-secret-with-at-least-32-characters';process.env.PIN_SECRET='test-only-pin-secret-with-at-least-32-characters';
test('Mechanic review, private identity, selection-only chat and alert recovery',async t=>{
 const db=new PGlite();await db.waitReady;for(const file of (await fs.readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.exec(await fs.readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 let tail=Promise.resolve();const pool={query:(s,p)=>db.query(s,p),connect:async()=>{const previous=tail;let release;tail=new Promise(r=>release=r);await previous;return {query:(s,p)=>db.query(s,p),release};}};
 const server=createApp(pool,{pushEnabled:true}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const api=async(method,path,body,user,status=200)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;};
 const reg=(role,n)=>api('POST','/api/auth/register',{user_type:role,full_name:'Test User '+n,phone_number:'+23762222222'+n,password:'StrongTestPassword!'});
 try{
 const driver=await reg('driver',1),mechanic=await reg('mechanic',2),admin=await reg('driver',3),outsider=await reg('driver',4);await db.query('UPDATE users SET is_admin=TRUE WHERE id=$1',[admin.userId]);
 const bytes=Buffer.alloc(150);bytes[0]=255;bytes[1]=216;bytes[148]=255;bytes[149]=217;const photo='data:image/jpeg;base64,'+bytes.toString('base64');
 const form={full_name:'Approved Mechanic',nationality:'Cameroonian',identity_type:'national_id',identity_number:'PRIVATE-ID-123456',identity_issue_date:'2024-01-01',identity_expiry_date:'2034-01-01',identity_no_expiry:false,garage_name:'Repair Garage',garage_address:'Bonaberi main road',locality:'Bonaberi',specialization:'Engine repair',years_experience:8,qualifications:'Technical certificate',garage_latitude:4.075,garage_longitude:9.675,portrait:photo,garage_photo:photo,consent:true};
 const data={title:'Engine failure',location:'Bonaberi',latitude:4.075,longitude:9.675};let request,quote,conversation;
 await t.test('new mechanics cannot enable availability, respond or list requests',async()=>{
  const own=await api('GET','/api/users/profile',null,mechanic);assert.equal(own.mechanic_review_status,'draft');assert.equal(own.availability,false);
  await api('PATCH','/api/users/profile',{availability:true},mechanic,403);
  await api('GET','/api/repair-requests',null,mechanic,403);
  request=await api('POST','/api/repair-requests',data,driver);assert.equal(request.notificationsQueued,0);
  await api('POST','/api/repair-requests/'+request.id+'/quotes',{},mechanic,403);
  await api('POST','/api/service-offers',{service_name:'Repair'},mechanic,403);
 });
 await t.test('required fields, dates, consent, image signatures and experience are validated',async()=>{
  for(const change of [{identity_number:''},{identity_issue_date:'2024-02-30'},{identity_expiry_date:'2025-01-01'},{years_experience:-1},{consent:false},{portrait:'data:image/jpeg;base64,AAAA'},{garage_latitude:100}])await api('PUT','/api/mechanic-profile',{...form,...change},mechanic,400);
  await api('PUT','/api/mechanic-profile',form,driver,403);
 });
 await t.test('submission encrypts identity, uses signup phone and remains pending',async()=>{
  assert.equal((await api('PUT','/api/mechanic-profile',{...form,phone_number:'+237699999999'},mechanic)).mechanic_review_status,'pending');
  const row=(await db.query('SELECT * FROM mechanic_profiles WHERE user_id=$1',[mechanic.userId])).rows[0];assert.equal(JSON.stringify(row).includes(form.identity_number),false);
  const own=await api('GET','/api/mechanic-profile',null,mechanic);assert.equal(own.identity_number,form.identity_number);assert.equal(own.phone_number,'+237622222222');
  assert.equal((await api('GET','/api/mechanics/available?latitude=4.075&longitude=9.675',null,driver)).length,0);
 });
 await t.test('only administrator can review identity and approve; review is audited',async()=>{
  await api('GET','/api/admin/mechanic-profiles/'+mechanic.userId,null,driver,403);
  await api('PATCH','/api/admin/mechanic-profiles/'+mechanic.userId,{status:'approved'},mechanic,403);
  assert.equal((await api('GET','/api/admin/mechanic-profiles/'+mechanic.userId,null,admin)).identity_number,form.identity_number);
  await api('PATCH','/api/admin/mechanic-profiles/'+mechanic.userId,{status:'approved'},admin);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM admin_audit')).rows[0].n,2);
 });
 await t.test('approved profile is public without document details or premature contact',async()=>{
  const p=await api('GET','/api/users/'+mechanic.userId,null,driver);assert.equal(p.garage_name,form.garage_name);assert.equal(p.portrait,photo);assert.equal(p.identity_number,undefined);assert.equal(p.private_cipher,undefined);assert.equal(p.can_message,false);assert.equal(p.phone,null);
 });
 await t.test('mechanic availability + late device registration recover open nearby alerts only once',async()=>{
  await api('PATCH','/api/users/profile',{availability:true,latitude:4.075,longitude:9.675},mechanic);
  await api('POST','/api/notifications/device',{installationId:'11111111-1111-4111-8111-111111111111',token:'fake-notification-token-for-approved-mechanic'},mechanic);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM push_outbox WHERE kind='request'")).rows[0].n,1);
  await reconcileRequestAlerts(pool,mechanic.userId);assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM push_outbox WHERE kind='request'")).rows[0].n,1);
  await api('PATCH','/api/users/language',{language:'fr'},mechanic);const sent=[];await drainPush(pool,async m=>sent.push(m));assert.equal(sent.length,1);assert.equal(sent[0].data.requestId,String(request.id));assert.equal(sent[0].data.targetUserId,String(mechanic.userId));assert.match(sent[0].notification.title,/proximité/);
 });
 await t.test('chat creation and legacy chat are denied before a response and selection',async()=>{
  await api('POST','/api/conversations',{other_user_id:mechanic.userId},driver,403);
  const c=(await db.query('INSERT INTO conversations(driver_id,mechanic_id) VALUES($1,$2) RETURNING id',[driver.userId,mechanic.userId])).rows[0];
  await api('POST','/api/conversations/'+c.id+'/messages',{message_text:'Bypass'},driver,403);
  quote=await api('POST','/api/repair-requests/'+request.id+'/quotes',{},mechanic);
  await api('POST','/api/conversations',{other_user_id:mechanic.userId},driver,403);
 });
 await t.test('driver selection creates isolated chat with wallet holds and working participant access',async()=>{
  const accepted=await api('PATCH','/api/quotes/'+quote.id+'/accept',{},driver);assert.ok(accepted.journey.id);
  conversation=await api('POST','/api/conversations',{other_user_id:mechanic.userId},driver);assert.equal(conversation.journey_id,accepted.journey.id);
  assert.equal((await api('GET','/api/users/'+mechanic.userId,null,driver)).can_message,true);
  await api('POST','/api/conversations/'+conversation.id+'/messages',{message_text:'I am on my way'},mechanic);
  assert.equal((await api('GET','/api/conversations/'+conversation.id+'/messages',null,driver)).length,1);
  await api('GET','/api/conversations/'+conversation.id+'/messages',null,outsider,403);
  const list=await api('GET','/api/conversations',null,driver);assert.equal(list.length,1);
 });
 await t.test('cancellation closes sending and later request cannot reopen old chat',async()=>{
  await api('DELETE','/api/repair-requests/'+request.id,null,driver);
  await api('POST','/api/conversations/'+conversation.id+'/messages',{message_text:'Bypass after cancellation'},mechanic,403);
  await api('POST','/api/conversations',{other_user_id:mechanic.userId},driver,403);
  const next=await api('POST','/api/repair-requests',data,driver);await api('POST','/api/conversations',{other_user_id:mechanic.userId},driver,403);
  const q=await api('POST','/api/repair-requests/'+next.id+'/quotes',{},mechanic);await api('PATCH','/api/quotes/'+q.id+'/accept',{},driver);
  const second=await api('POST','/api/conversations',{other_user_id:mechanic.userId},driver);assert.notEqual(second.id,conversation.id);
  await api('POST','/api/conversations/'+conversation.id+'/messages',{message_text:'Cross request bypass'},driver,403);
  await api('PUT','/api/mechanic-profile',form,mechanic,409);
  await api('DELETE','/api/repair-requests/'+next.id,null,driver);
 });
 await t.test('voice request, quote and chat roundtrip preserve selection and ownership restrictions',async()=>{
  const bytes=Buffer.alloc(120);bytes.writeUInt32BE(24,0);bytes.write('ftyp',4);bytes.write('M4A ',8);const voice={audio_note:'data:audio/mp4;base64,'+bytes.toString('base64'),audio_duration:5};
  await api('POST','/api/repair-requests',{...data,...voice,audio_duration:61},driver,400);
  await api('POST','/api/repair-requests',{...data,audio_note:'data:audio/mp4;base64,AAAA',audio_duration:1},driver,400);
  await api('POST','/api/repair-requests',{...data,...voice,audio_note:'data:audio/mp4;base64,'+Buffer.alloc(350001).toString('base64')},driver,400);
  const request=await api('POST','/api/repair-requests',{...data,...voice},driver);
  const list=await api('GET','/api/repair-requests',null,driver);assert.equal(list.find(r=>r.id===request.id).has_audio,true);assert.equal(list.find(r=>r.id===request.id).audio_note,undefined);
  assert.equal((await api('GET','/api/repair-requests/'+request.id+'/audio',null,mechanic)).audio_note,voice.audio_note);
  await api('GET','/api/repair-requests/'+request.id+'/audio',null,outsider,403);
  const q=await api('POST','/api/repair-requests/'+request.id+'/quotes',voice,mechanic);
  assert.equal((await api('GET','/api/quotes/'+q.id+'/audio',null,driver)).audio_note,voice.audio_note);
  await api('GET','/api/quotes/'+q.id+'/audio',null,outsider,403);
  const detail=await api('GET','/api/repair-requests/'+request.id,null,driver);assert.equal(detail.has_audio,true);assert.equal(detail.quotes[0].has_audio,true);assert.equal(detail.quotes[0].audio_note,undefined);
  await api('POST','/api/conversations',{other_user_id:mechanic.userId},driver,403);
  await api('PATCH','/api/quotes/'+q.id+'/accept',{},driver);
  const c=await api('POST','/api/conversations',{other_user_id:mechanic.userId},driver);
  const m=await api('POST','/api/conversations/'+c.id+'/messages',voice,driver);
  assert.equal(m.has_audio,true);assert.equal((await api('GET','/api/messages/'+m.id+'/audio',null,mechanic)).audio_note,voice.audio_note);
  await api('GET','/api/messages/'+m.id+'/audio',null,outsider,403);
  assert.equal((await api('GET','/api/conversations/'+c.id+'/messages',null,mechanic))[0].has_audio,true);
  await api('DELETE','/api/repair-requests/'+request.id,null,driver);
  await api('POST','/api/conversations/'+c.id+'/messages',voice,mechanic,403);
 });
 await t.test('5 km limits apply to request browsing, direct detail/audio access and responding',async()=>{
   const far=await reg('mechanic',5);await db.query("UPDATE users SET mechanic_review_status='approved',availability=TRUE,location_latitude=4.135,location_longitude=9.675,location_updated_at=CURRENT_TIMESTAMP WHERE id=$1",[far.userId]);
   const r=await api('POST','/api/repair-requests',data,driver);
   assert.equal((await api('GET','/api/repair-requests',null,far)).length,0);
   await api('GET','/api/repair-requests/'+r.id,null,far,403);
   await api('GET','/api/repair-requests/'+r.id+'/audio',null,far,403);
   await api('POST','/api/repair-requests/'+r.id+'/quotes',{},far,403);
   await api('DELETE','/api/repair-requests/'+r.id,null,driver);
 });
 await t.test('profile edits require approval again; rejected profile can be corrected',async()=>{
  await api('PUT','/api/mechanic-profile',form,mechanic);assert.equal((await api('GET','/api/users/profile',null,mechanic)).availability,false);
  await api('PATCH','/api/admin/mechanic-profiles/'+mechanic.userId,{status:'rejected'},admin,400);
  await api('PATCH','/api/admin/mechanic-profiles/'+mechanic.userId,{status:'rejected',note:'Garage sign needs a clearer photo'},admin);
  await api('POST','/api/quotes',{repair_request_id:request.id},mechanic,403);
  await api('PUT','/api/mechanic-profile',{...form,identity_no_expiry:true,identity_expiry_date:''},mechanic);
  assert.equal((await api('GET','/api/mechanic-profile',null,mechanic)).identity_expiry_date,null);
 });
 }finally{await new Promise(r=>server.close(r));await db.close();}
});
