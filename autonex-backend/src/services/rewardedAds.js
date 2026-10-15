import {randomBytes,verify} from 'node:crypto';
import {WorkflowError} from './feeService.js';
const TEST_UNIT='ca-app-pub-3940256099942544/5224354917';
const keyCache=new Map();let refreshed=0,inFlight=null;
async function googleKey(id){
 if(Date.now()-refreshed<21600000&&keyCache.has(id))return keyCache.get(id);
 if(Date.now()-refreshed<60000&&!keyCache.has(id))throw new WorkflowError('Unknown reward verification key',400);
 if(!inFlight)inFlight=(async()=>{const r=await fetch('https://www.gstatic.com/admob/reward/verifier-keys.json',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new WorkflowError('Reward verification temporarily unavailable',503);const d=await r.json();keyCache.clear();for(const key of d.keys||[])if(key.keyId&&key.pem)keyCache.set(String(key.keyId),key.pem);refreshed=Date.now();})().finally(()=>{inFlight=null;});
 await inFlight;if(!keyCache.has(id))throw new WorkflowError('Unknown reward verification key',400);return keyCache.get(id);
}
export async function verifyRewardCallback(raw,getKey=googleKey){
 if(raw.length>10000)throw new WorkflowError('Invalid reward callback',400);
 const match=raw.match(/^(.*)&signature=([A-Za-z0-9_%=-]+)&key_id=(\d+)$/);
 if(!match)throw new WorkflowError('Signed reward callback required',400);
 const p=new URLSearchParams(raw);const seen=new Set();for(const [key] of p){if(seen.has(key))throw new WorkflowError('Duplicate reward parameter',400);seen.add(key);}
 const signature=Buffer.from(decodeURIComponent(match[2]),'base64url');
 if(!verify('sha256',Buffer.from(match[1],'utf8'),await getKey(match[3]),signature))throw new WorkflowError('Invalid reward signature',400);
 const timestamp=Number(p.get('timestamp'));
 if(!Number.isSafeInteger(timestamp)||timestamp>Date.now()+300000||timestamp<Date.now()-172800000||p.get('reward_amount')!=='2'||p.get('reward_item')!=='connection_credits'||!/^[-a-zA-Z0-9_]{8,150}$/.test(p.get('transaction_id')||'')||!/^ad_[a-f0-9]{64}$/.test(p.get('custom_data')||''))throw new WorkflowError('Invalid reward details',400);
 return {sessionId:p.get('custom_data'),transactionId:p.get('transaction_id'),adUnit:p.get('ad_unit'),timestamp};
}
export async function grantAdReward(c,{sessionId,transactionId,adUnit,timestamp},mode){
 const base=(await c.query('SELECT user_id FROM rewarded_ad_sessions WHERE id=$1',[sessionId])).rows[0];if(!base)throw new WorkflowError('Reward session not found',404);
 // Account-first lock order matches other credit grants and new ad sessions.
 const w=(await c.query('SELECT * FROM connection_credit_accounts WHERE user_id=$1 FOR UPDATE',[base.user_id])).rows[0];
 const s=(await c.query('SELECT * FROM rewarded_ad_sessions WHERE id=$1 FOR UPDATE',[sessionId])).rows[0];
 if(s.mode!==mode||(s.ad_unit!==adUnit&&s.ad_unit.split('/')[1]!==adUnit)||timestamp<new Date(s.created_at).getTime()-300000||timestamp>new Date(s.expires_at).getTime())throw new WorkflowError('Reward does not match its session',400);
 const old=(await c.query('SELECT * FROM rewarded_ad_grants WHERE transaction_id=$1',[transactionId])).rows[0];
 if(old){if(old.session_id!==s.id)throw new WorkflowError('Reward transaction already used',409);return {duplicate:true,credits:2};}
 if(s.credited)return {duplicate:true,credits:2};
 const u=(await c.query('SELECT is_active,suspended FROM users WHERE id=$1',[s.user_id])).rows[0];if(!u.is_active||u.suspended)throw new WorkflowError('Account unavailable',403);
 await c.query('INSERT INTO rewarded_ad_grants(transaction_id,session_id,user_id,mode) VALUES($1,$2,$3,$4)',[transactionId,s.id,s.user_id,mode]);
 await c.query('UPDATE connection_credit_accounts SET balance=balance+2 WHERE user_id=$1',[s.user_id]);
 await c.query('UPDATE rewarded_ad_sessions SET credited=TRUE,client_completed=TRUE WHERE id=$1',[s.id]);
 await c.query("INSERT INTO connection_credit_transactions(user_id,transaction_type,amount,balance_before,balance_after,source,reference_id,description) VALUES($1,'ad_reward',2,$2,$3,$4,$5,'Completed rewarded ad: 2 connection credits')",[s.user_id,w.balance,w.balance+2,mode==='test'?'ad_test':'admob',transactionId]);
 return {duplicate:false,credits:2,balance:w.balance+2};
}
function configuration(){
 if(process.env.APP_ENV==='test'&&process.env.ALLOW_TEST_AD_REWARDS==='true')return {mode:'test',unit:TEST_UNIT};
 const unit=process.env.ADMOB_REWARDED_AD_UNIT||'';
 if(process.env.REWARDED_ADS_ENABLED==='true'&&/^ca-app-pub-\d{16}\/\d{10}$/.test(unit)&&unit!==TEST_UNIT)return {mode:'live',unit};
 return {mode:'disabled',unit:''};
}
export function rewardedAds({route,auth,tx,pool}){
 route('get','/api/credits/rewarded-ads',async req=>{const config=configuration();const sessions=(await pool.query("SELECT id,slot,credited,client_completed FROM rewarded_ad_sessions WHERE user_id=$1 AND reward_day=(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Douala')::date ORDER BY slot",[req.user.id])).rows;return {enabled:config.mode!=='disabled',mode:config.mode,creditsPerAd:2,dailyAds:5,dailyCredits:10,earnedToday:sessions.filter(s=>s.credited).length*2,remainingAds:5-sessions.filter(s=>s.credited).length,pending:sessions.find(s=>!s.credited&&s.client_completed)?.id||null};},auth);
 route('post','/api/credits/rewarded-ads/sessions',req=>tx(async c=>{
  const cfg=configuration();if(cfg.mode==='disabled')throw new WorkflowError('Rewarded ads are not activated yet',503);
  await c.query('SELECT user_id FROM connection_credit_accounts WHERE user_id=$1 FOR UPDATE',[req.user.id]);
  const active=(await c.query("SELECT * FROM journeys WHERE (driver_id=$1 OR mechanic_id=$1) AND status IN ('active','both_arrived') AND expires_at>CURRENT_TIMESTAMP LIMIT 1",[req.user.id])).rows[0];if(active)throw new WorkflowError('Ads are unavailable during an active connection',409);
  const pendingRequest=(await c.query("SELECT id FROM repair_requests WHERE status='open' AND expires_at>CURRENT_TIMESTAMP AND target_mechanic_id=$1 AND connection_stage='ping' LIMIT 1",[req.user.id])).rows[0];if(pendingRequest)throw new WorkflowError('Accept or decline the incoming alert before watching ads',409);
  const sessions=(await c.query("SELECT * FROM rewarded_ad_sessions WHERE user_id=$1 AND reward_day=(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Douala')::date ORDER BY slot",[req.user.id])).rows;
  let s=sessions.find(s=>!s.credited);
  if(s?.client_completed)throw new WorkflowError('Your completed ad reward is awaiting verification. Refresh shortly.',409);
  if(sessions.filter(s=>s.credited).length>=5)throw new WorkflowError('Daily limit reached: 10 credits from five completed ads',429);
  if(s){if(s.mode!==cfg.mode||s.ad_unit!==cfg.unit)throw new WorkflowError('Ad settings changed. Contact support or try tomorrow.',409);await c.query("UPDATE rewarded_ad_sessions SET expires_at=CURRENT_TIMESTAMP+INTERVAL '1 hour' WHERE id=$1",[s.id]);}
  else{s=(await c.query("INSERT INTO rewarded_ad_sessions(id,user_id,reward_day,slot,mode,ad_unit) VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Douala')::date,$3,$4,$5) RETURNING *",['ad_'+randomBytes(32).toString('hex'),req.user.id,sessions.length+1,cfg.mode,cfg.unit])).rows[0];}
  return {id:s.id,mode:s.mode,adUnit:s.ad_unit,credits:2};
 }),auth);
 route('post','/api/credits/rewarded-ads/sessions/:id/completed',req=>tx(async c=>{
  const s=(await c.query('SELECT * FROM rewarded_ad_sessions WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id])).rows[0];if(!s)throw new WorkflowError('Reward session not found',404);
  if(s.mode==='test'){if(configuration().mode!=='test')throw new WorkflowError('Test rewards disabled',403);return grantAdReward(c,{sessionId:s.id,transactionId:'test_'+s.id,adUnit:s.ad_unit,timestamp:Date.now()},'test');}
  await c.query('UPDATE rewarded_ad_sessions SET client_completed=TRUE WHERE id=$1',[s.id]);return {pending:!s.credited,credits:s.credited?2:0};
 }),auth);
 route('get','/api/credits/rewarded-ads/ssv',async req=>{const reward=await verifyRewardCallback(req.originalUrl.split('?')[1]||'');return tx(c=>grantAdReward(c,reward,'live'));});
}
