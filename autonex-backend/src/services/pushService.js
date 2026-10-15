import { distance, transaction } from './workflowService.js';
export const PUSH_PROJECT = 'autonex-test-b13ab';
export async function firebaseSender(raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
 if (!raw) return null;
 let config;
 try { config = JSON.parse(raw); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON'); }
 if (config.project_id !== PUSH_PROJECT || !config.private_key || !config.client_email)
   throw new Error('Firebase credentials must belong to the RESQUORA test project');
 const { initializeApp, cert } = await import('firebase-admin/app');
 const { getMessaging } = await import('firebase-admin/messaging');
 const app = initializeApp({ credential: cert(config) }, 'autonex-pilot');
 return message => getMessaging(app).send(message);
}
export function pushRadius() { return 5000; }
export async function queueRequestAlerts(c, request) {
 const devices = (await c.query(`SELECT d.installation_id,d.user_id,u.location_latitude,u.location_longitude
 FROM push_devices d JOIN users u ON u.id=d.user_id
 WHERE u.user_type='mechanic' AND u.availability=TRUE AND NOT u.suspended AND u.is_active=TRUE AND u.mechanic_review_status='approved'
 AND u.location_updated_at>CURRENT_TIMESTAMP-INTERVAL '24 hours'
 AND d.updated_at>CURRENT_TIMESTAMP-INTERVAL '30 days'
 AND u.location_latitude IS NOT NULL AND u.location_longitude IS NOT NULL`)).rows;
 let queued = 0;
 for (const d of devices) {
   if(request.target_mechanic_id && (d.user_id!==request.target_mechanic_id || !['ping','offer'].includes(request.connection_stage)))continue;
   if (distance(request, {latitude:d.location_latitude,longitude:d.location_longitude}) > (request.target_mechanic_id?request.search_radius_m:pushRadius())) continue;
   const inserted = await c.query(`INSERT INTO push_outbox(event_key,user_id,installation_id,repair_request_id,kind,expires_at,alert_action)
   VALUES($1,$2,$3,$4,'request',$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
   ['request_'+request.id+'_'+(request.connection_stage||'broadcast')+'_'+(request.direct_attempt||0),d.user_id,d.installation_id,request.id,request.connection_stage==='ping'?new Date(Math.min(new Date(request.expires_at).getTime(),Date.now()+20000)).toISOString():request.expires_at,request.connection_stage==='ping'?'ring':'notify']);
   queued += inserted.rows.length;
 }
 return queued;
}
export async function queueAlertStop(c,requestId,mechanicId,attempt){
 if(!mechanicId)return;
 const devices=(await c.query('SELECT installation_id FROM push_devices WHERE user_id=$1',[mechanicId])).rows;
 for(const d of devices)await c.query("INSERT INTO push_outbox(event_key,user_id,installation_id,repair_request_id,kind,expires_at,alert_action) VALUES($1,$2,$3,$4,'request',CURRENT_TIMESTAMP+INTERVAL '5 minutes','stop') ON CONFLICT DO NOTHING",['stop_'+requestId+'_'+attempt,mechanicId,d.installation_id,requestId]);
}
export async function drainPush(pool, send, limit=20) {
 if (!send) return 0;
 let processed=0;
 for (let i=0; i<limit; i++) {
   const found = await transaction(pool, async c => {
     const row = (await c.query(`SELECT * FROM push_outbox WHERE status='pending'
       AND next_attempt_at<=CURRENT_TIMESTAMP ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
     if (!row) return false;
     const device = (await c.query(`SELECT d.token,u.availability,u.suspended,u.is_active,u.preferred_language,u.mechanic_review_status
       FROM push_devices d JOIN users u ON u.id=d.user_id
       WHERE d.installation_id=$1 AND d.user_id=$2 AND d.updated_at>CURRENT_TIMESTAMP-INTERVAL '30 days'`,
       [row.installation_id,row.user_id])).rows[0];
     const request = row.repair_request_id ? (await c.query('SELECT status,expires_at,target_mechanic_id,connection_stage,direct_attempt FROM repair_requests WHERE id=$1',[row.repair_request_id])).rows[0] : null;
     if (!device || (row.alert_action!=='stop' && (device.suspended || !device.is_active)) || new Date(row.expires_at)<=new Date() ||
       (row.kind==='request' && row.alert_action!=='stop' && (!device.availability || device.mechanic_review_status!=='approved' || request?.status!=='open' || (request.target_mechanic_id && (request.target_mechanic_id!==row.user_id || !['ping','offer'].includes(request.connection_stage) || !row.event_key.endsWith('_'+request.connection_stage+'_'+request.direct_attempt))) || new Date(request.expires_at)<=new Date()))) {
       await c.query("UPDATE push_outbox SET status='skipped' WHERE id=$1",[row.id]);
       return true;
     }
     try {
       const message={token:device.token,
         notification:{title:device.preferred_language==='fr'?(row.kind==='test'?'RESQUORA : alerte de test':'RESQUORA : demande de réparation à proximité'):(row.kind==='test'?'RESQUORA test alert':'RESQUORA: nearby repair request'),
           body:device.preferred_language==='fr'?(row.kind==='test'?'Les notifications arrivent sur ce téléphone.':'Un conducteur à proximité a besoin d’un mécanicien. Ouvrez RESQUORA pour voir les demandes.'):(row.kind==='test'?'Notifications are reaching this phone.':'A driver nearby needs a mechanic. Open RESQUORA to view available requests.')},
         data:{targetUserId:String(row.user_id),kind:row.kind,requestId:String(row.repair_request_id||''),eventId:String(row.id)},
         android:{priority:'high',ttl:Math.max(1000,Math.min(300000,new Date(row.expires_at)-Date.now())),
           notification:{channelId:'autonex_requests',sound:'default',tag:row.event_key,icon:'ic_notification'}}};
       if(row.alert_action==='ring'||row.alert_action==='stop'){
         const stopAttempt=row.alert_action==='stop'?row.event_key.split('_').pop():String(request.direct_attempt);
         message.data={...message.data,alertAction:row.alert_action,attempt:stopAttempt,expiresAt:String(new Date(row.expires_at).getTime()),title:message.notification.title,body:device.preferred_language==='fr'?'Un conducteur vous sollicite. Accepter ou refuser ?':'A driver is requesting your help. Accept or decline?'};
         delete message.notification;delete message.android.notification;
       }
       await send(message);
       await c.query("UPDATE push_outbox SET status='sent',sent_at=CURRENT_TIMESTAMP,attempts=attempts+1,last_error=NULL WHERE id=$1",[row.id]);
     } catch(e) {
       // Store only the SDK error code, never a token, credential or provider message.
       const code = typeof e.code==='string' && /^[a-zA-Z0-9_/-]{1,100}$/.test(e.code) ? e.code : 'push/send-failed';
       const invalid=['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(code);
       if (invalid) await c.query('DELETE FROM push_devices WHERE installation_id=$1 AND token=$2',[row.installation_id,device.token]);
       else await c.query(`UPDATE push_outbox SET attempts=attempts+1,last_error=$2,
         status=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,
         next_attempt_at=CURRENT_TIMESTAMP+INTERVAL '30 seconds' WHERE id=$1`,[row.id,code]);
     }
     return true;
   });
   if (!found) break;
   processed++;
 }
 return processed;
}

// Recover open requests when a phone registers or its mechanic becomes available.
// Reusing event/install keys ensures repeated refreshes do not duplicate alerts.
export async function reconcileRequestAlerts(pool,userId=null){
 const eligible=(await pool.query("SELECT id FROM users WHERE user_type='mechanic' AND mechanic_review_status='approved' AND availability=TRUE AND NOT suspended AND is_active=TRUE AND ($1::integer IS NULL OR id=$1)",[userId])).rows;
 if(!eligible.length)return 0;
 const requests=(await pool.query("SELECT * FROM repair_requests WHERE status='open' AND expires_at>CURRENT_TIMESTAMP AND created_at>CURRENT_TIMESTAMP-INTERVAL '5 minutes' ORDER BY id DESC LIMIT 100")).rows;
 let queued=0;for(const r of requests)queued+=await queueRequestAlerts(pool,r);return queued;
}
