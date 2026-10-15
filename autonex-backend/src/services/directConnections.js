import {queueAlertStop} from './pushService.js';
import {createRequest,coordinates,distance} from './workflowService.js';
import {requireApproved} from './profileService.js';
import {WorkflowError,releaseFee} from './feeService.js';
export async function validateTarget(c,id,data){
 if(!Number.isSafeInteger(id)||![5000,10000,20000,50000].includes(data.radius))throw new WorkflowError('Choose a mechanic and a supported search radius',400);
 await requireApproved(c,id);
 const u=(await c.query('SELECT * FROM users WHERE id=$1',[id])).rows[0];
 if(!u.availability||!u.location_updated_at||Date.now()-new Date(u.location_updated_at)>86400000||u.location_latitude==null||u.location_longitude==null||distance(data,{latitude:u.location_latitude,longitude:u.location_longitude})>data.radius)throw new WorkflowError('Mechanic is no longer available within this radius',409);
}
export async function ownedSearch(c,id,user,mechanic=false){
 const r=(await c.query('SELECT * FROM repair_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!r?.connection_stage||(mechanic?r.target_mechanic_id!==user:r.driver_id!==user))throw new WorkflowError('Request access denied',403);
 if(r.status!=='open'||new Date(r.expires_at)<=new Date())throw new WorkflowError('Request is closed or expired',409);
 return r;
}
export async function releaseMechanic(c,r){
 const holds=(await c.query("SELECT id FROM connection_credit_reservations WHERE repair_request_id=$1 AND fee_type='connection_fee_mechanic' AND status='reserved' ORDER BY user_id",[r.id])).rows;
 for(const h of holds)await releaseFee(h.id,'Driver continues search',c);
 await c.query("UPDATE quotes SET status='rejected' WHERE repair_request_id=$1 AND status='pending'",[r.id]);
}
export function directConnections({route,auth,role,tx,queueRequestAlerts}){
 route('post','/api/connection-searches',req=>tx(async c=>{
  coordinates(req.body);const ref=req.body.reference;
  if(typeof ref!=='string'||!/^direct_[a-zA-Z0-9_-]{8,100}$/.test(ref))throw new WorkflowError('A retry reference is required',400);
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[req.user.id]);
  const old=(await c.query('SELECT * FROM repair_requests WHERE driver_id=$1 AND client_reference=$2',[req.user.id,ref])).rows[0];if(old)return old;
  const existing=(await c.query("SELECT * FROM repair_requests WHERE driver_id=$1 AND connection_stage IS NOT NULL AND status='open'",[req.user.id])).rows[0];if(existing){if(new Date(existing.expires_at)>new Date())return existing;throw new WorkflowError('Previous search is expiring. Refresh and retry.',409);}
  await validateTarget(c,req.body.mechanicId,req.body);
  const r=await createRequest(c,req.user.id,{...req.body,title:'Direct mechanic assistance',location:'Vehicle GPS location',description:''});
  const updated=(await c.query("UPDATE repair_requests SET target_mechanic_id=$1,connection_stage='ping',search_radius_m=$2,client_reference=$3 WHERE id=$4 RETURNING *",[req.body.mechanicId,req.body.radius,ref,r.id])).rows[0];
  await queueRequestAlerts(c,updated);return updated;
 }),auth,role('driver'));
 route('post','/api/connection-searches/:id/target',req=>tx(async c=>{
  const r=await ownedSearch(c,req.params.id,req.user.id);
  if(r.connection_stage!=='searching')throw new WorkflowError('Decline the current offer or cancel before choosing another mechanic',409);
  await validateTarget(c,req.body.mechanicId,{latitude:Number(r.latitude),longitude:Number(r.longitude),radius:req.body.radius});
  const updated=(await c.query("UPDATE repair_requests SET target_mechanic_id=$1,search_radius_m=$2,direct_attempt=direct_attempt+1,connection_stage='ping',description='',audio_note=NULL,audio_duration=NULL WHERE id=$3 RETURNING *",[req.body.mechanicId,req.body.radius,r.id])).rows[0];
  // A new target gets its own notification event even when reusing a driver's hold.
  await c.query("DELETE FROM push_outbox WHERE repair_request_id=$1 AND user_id=$2 AND status IN ('skipped','failed')",[r.id,req.body.mechanicId]);
  await queueRequestAlerts(c,updated);return updated;
 }),auth,role('driver'));
 route('post','/api/connection-searches/:id/availability',req=>tx(async c=>{
  const r=await ownedSearch(c,req.params.id,req.user.id,true);await requireApproved(c,req.user.id);
  if(!['accept','decline'].includes(req.body.decision))throw new WorkflowError('Choose accept or decline',400);
  if(req.body.attempt!=null&&Number(req.body.attempt)!==r.direct_attempt)throw new WorkflowError('This alert is no longer current',409);
  if(r.connection_stage!=='ping')throw new WorkflowError('This alert has already been handled',409);
  await queueAlertStop(c,r.id,req.user.id,r.direct_attempt);
  await c.query('INSERT INTO mechanic_response_events(request_id,direct_attempt,driver_id,mechanic_id,decision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[r.id,r.direct_attempt,r.driver_id,req.user.id,req.body.decision]);
  return (await c.query('UPDATE repair_requests SET connection_stage=$1 WHERE id=$2 RETURNING *',[req.body.decision==='accept'?'describe':'searching',r.id])).rows[0];
 }),auth,role('mechanic'));
 route('put','/api/connection-searches/:id/description',req=>tx(async c=>{
  const r=await ownedSearch(c,req.params.id,req.user.id);
  if(r.connection_stage!=='describe')throw new WorkflowError('Wait for mechanic availability confirmation',409);
  if(!String(req.body.description||'').trim()&&!req.body.audio_note)throw new WorkflowError('Describe the problem or record a voice note',400);
  const {audioNote}=await import('./audioService.js');const voice=audioNote(req.body);
  if(String(req.body.description||'').length>4000||!['car','truck','motorcycle','bus','other'].includes(req.body.vehicle_type))throw new WorkflowError('Invalid description or vehicle type',400);
  const updated=(await c.query("UPDATE repair_requests SET description=$1,vehicle_type=$2,audio_note=$3,audio_duration=$4,connection_stage='offer' WHERE id=$5 RETURNING id,connection_stage",[req.body.description||'',req.body.vehicle_type,voice.note,voice.duration,r.id])).rows[0];await queueRequestAlerts(c,{...r,connection_stage:'offer'});return updated;
 }),auth,role('driver'));
 route('post','/api/connection-searches/:id/decline',req=>tx(async c=>{
  const r=await ownedSearch(c,req.params.id,req.user.id);
  if(!['offered','ping','describe','offer'].includes(r.connection_stage))throw new WorkflowError('No current offer to decline',409);
  await queueAlertStop(c,r.id,r.target_mechanic_id,r.direct_attempt);
  await releaseMechanic(c,r);await c.query("UPDATE repair_requests SET connection_stage='searching' WHERE id=$1",[r.id]);return {stage:'searching',driverCreditsStillReserved:10};
 }),auth,role('driver'));
}
