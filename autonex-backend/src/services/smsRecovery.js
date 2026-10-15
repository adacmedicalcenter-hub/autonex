import {createHash,randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {WorkflowError} from './feeService.js';
import {cameroonPhone} from './creditService.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
function config(){const sid=process.env.TWILIO_ACCOUNT_SID,token=process.env.TWILIO_AUTH_TOKEN,service=process.env.TWILIO_VERIFY_SERVICE_SID;
 if(process.env.SMS_RECOVERY_ENABLED!=='true'||!/^AC[a-f0-9]{32}$/i.test(sid||'')||!token||!/^VA[a-f0-9]{32}$/i.test(service||''))throw new WorkflowError('SMS recovery is not activated yet. Contact RESQUORA support for a recovery code.',503);
 return {sid,token,service};}
async function verifyCall(path,body){const c=config();let response;
 try{response=await fetch('https://verify.twilio.com/v2/Services/'+c.service+'/'+path,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(c.sid+':'+c.token).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body),signal:AbortSignal.timeout(15000)});}catch{throw new WorkflowError('SMS service unavailable. Please try again later.',503);}
 if(!response.ok){if(response.status===404||response.status===400)return null;if(response.status===429)throw new WorkflowError('Too many recovery attempts. Please try again later.',429);throw new WorkflowError('SMS service unavailable. Please try again later.',503);}
 return response.json();}
export function smsRecovery({route,pool,tx}){
 route('post','/api/auth/recovery/request',async req=>{
  config();const phone=cameroonPhone(req.body.phone_number),phoneHash=hash(phone),id=randomBytes(32).toString('hex');
  const user=await tx(async c=>{
   await c.query('LOCK TABLE sms_recovery_requests IN SHARE ROW EXCLUSIVE MODE');
   const volume=(await c.query("SELECT COUNT(*)::int AS n FROM sms_recovery_requests WHERE created_at>now()-INTERVAL '1 hour'")).rows[0].n;
   if(volume>=100)throw new WorkflowError('SMS recovery is temporarily busy. Please try again later.',429);
   const recent=(await c.query("SELECT created_at FROM sms_recovery_requests WHERE phone_hash=$1 AND created_at>now()-INTERVAL '1 hour' ORDER BY created_at DESC",[phoneHash])).rows;
   if(recent.length>=3||(recent[0]&&Date.now()-Date.parse(recent[0].created_at)<60000))throw new WorkflowError('Please wait before requesting another recovery code.',429);
   const u=(await c.query('SELECT id,auth_version FROM users WHERE phone_number=$1 AND is_active AND NOT suspended AND NOT is_admin',[phone])).rows[0];
   await c.query("UPDATE sms_recovery_requests SET used_at=now() WHERE phone_hash=$1 AND used_at IS NULL",[phoneHash]);
   await c.query('INSERT INTO sms_recovery_requests(id,phone_hash,user_id,auth_version) VALUES($1,$2,$3,$4)',[id,phoneHash,u?.id||null,u?.auth_version??null]);return u;
  });
  if(user){const result=await verifyCall('Verifications',{To:phone,Channel:'sms'});
   if(!result||result.status!=='pending'||!/^VE[a-f0-9]{32}$/i.test(result.sid||''))throw new WorkflowError('SMS could not be requested. Please try again later.',503);
   await pool.query('UPDATE sms_recovery_requests SET verification_sid=$1 WHERE id=$2',[result.sid,id]);}
  return {requestId:id,message:'If this number belongs to an eligible account, a recovery code has been requested by SMS.',expiresInMinutes:10};
 });
 route('post','/api/auth/recovery/complete',async req=>{
  config();const {requestId,code,password}=req.body;
  if(!/^[a-f0-9]{64}$/.test(requestId||'')||!/^\d{4,10}$/.test(code||'')||typeof password!=='string'||password.length<8||password.length>128)throw new WorkflowError('Invalid recovery details',400);
  // Commit the attempt before contacting the provider, so failed checks cannot roll it back.
  const claimed=await tx(async c=>{const row=(await c.query('SELECT * FROM sms_recovery_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
   if(!row||row.used_at||Date.parse(row.expires_at)<=Date.now()||row.attempts>=5)throw new WorkflowError('Invalid or expired recovery code',400);
   await c.query('UPDATE sms_recovery_requests SET attempts=attempts+1 WHERE id=$1',[requestId]);return row;});
  if(!claimed.user_id||!claimed.verification_sid)throw new WorkflowError('Invalid or expired recovery code',400);
  const result=await verifyCall('VerificationCheck',{VerificationSid:claimed.verification_sid,Code:code});
  if(!result||result.status!=='approved'||result.sid!==claimed.verification_sid)throw new WorkflowError('Invalid or expired recovery code',400);
  const passwordHash=await bcrypt.hash(password,10);
  return tx(async c=>{const row=(await c.query('SELECT * FROM sms_recovery_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
   const u=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[claimed.user_id])).rows[0];
   if(row.used_at||Date.parse(row.expires_at)<=Date.now()||!u||!u.is_active||u.suspended||u.is_admin||u.auth_version!==row.auth_version)throw new WorkflowError('Invalid or expired recovery code',400);
   await c.query('UPDATE users SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2',[passwordHash,u.id]);
   await c.query('UPDATE sms_recovery_requests SET used_at=now() WHERE phone_hash=$1 AND used_at IS NULL',[row.phone_hash]);
   await c.query('UPDATE account_recovery_codes SET used_at=now() WHERE user_id=$1',[u.id]);
   await c.query('DELETE FROM push_devices WHERE user_id=$1',[u.id]);return {recovered:true};});
 });
}
