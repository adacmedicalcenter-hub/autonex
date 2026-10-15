import {WorkflowError} from './feeService.js';
import {journey} from './workflowService.js';
export async function mechanicScores(c){
 const reviews=(await c.query('SELECT mechanic_id,AVG(stars)::float AS average,COUNT(*)::int AS count FROM verified_mechanic_feedback GROUP BY mechanic_id')).rows;
 // One outcome per driver/mechanic/day prevents one driver flooding the score.
 const responses=(await c.query("SELECT mechanic_id,COUNT(*)::int AS attempts,COUNT(*) FILTER(WHERE decision='accept')::int AS accepted FROM (SELECT DISTINCT ON(mechanic_id,driver_id,(created_at AT TIME ZONE 'Africa/Douala')::date) * FROM mechanic_response_events WHERE created_at>CURRENT_TIMESTAMP-INTERVAL '30 days' ORDER BY mechanic_id,driver_id,(created_at AT TIME ZONE 'Africa/Douala')::date,created_at DESC,id DESC) e GROUP BY mechanic_id")).rows;
 const ids=new Set([...reviews,...responses].map(x=>x.mechanic_id));const result={};
 for(const id of ids){const r=reviews.find(x=>x.mechanic_id===id),a=responses.find(x=>x.mechanic_id===id);const satisfaction=((r?.average||0)*(r?.count||0)+3.5*5)/((r?.count||0)+5);const responsiveness=((a?.accepted||0)+4)/((a?.attempts||0)+5);result[id]={customer_rating:r?Math.round(r.average*10)/10:null,review_count:r?.count||0,response_acceptance_percent:a?Math.round(a.accepted/a.attempts*100):null,response_count:a?.attempts||0,priority_score:Math.round((0.8*satisfaction+0.2*5*responsiveness)*100)/100};}
 return result;
}
export function feedbackRoutes({route,auth,role,tx,pool}){
 route('post','/api/journeys/:id/feedback',req=>tx(async c=>{
  const j=await journey(c,req.params.id,req.user.id);
  if(j.driver_id!==req.user.id)throw new WorkflowError('Only the connected driver can rate this mechanic',403);
  if(!j.both_fees_collected||!['completed','cancelled','expired'].includes(j.status))throw new WorkflowError('Rate a closed, confirmed connection',409);
  const stars=req.body.stars,comment=String(req.body.comment||'').trim();if(!Number.isInteger(stars)||stars<1||stars>5||comment.length>1000)throw new WorkflowError('Choose 1 to 5 stars and a comment up to 1000 characters',400);
  const old=(await c.query('SELECT * FROM verified_mechanic_feedback WHERE journey_id=$1',[j.id])).rows[0];if(old){if(old.stars!==stars||old.comment!==comment)throw new WorkflowError('Feedback already submitted',409);return old;}
  return (await c.query('INSERT INTO verified_mechanic_feedback(journey_id,driver_id,mechanic_id,stars,comment) VALUES($1,$2,$3,$4,$5) RETURNING *',[j.id,req.user.id,j.mechanic_id,stars,comment])).rows[0];
 }),auth,role('driver'));
 route('get','/api/journeys/:id/feedback',req=>tx(async c=>{const j=await journey(c,req.params.id,req.user.id);if(j.driver_id!==req.user.id)throw new WorkflowError('Driver access required',403);return (await c.query('SELECT * FROM verified_mechanic_feedback WHERE journey_id=$1',[j.id])).rows[0]||{submitted:false};}),auth,role('driver'));
 route('get','/api/mechanic-rating',async req=>(await mechanicScores(pool))[req.user.id]||{customer_rating:null,review_count:0,response_acceptance_percent:null,response_count:0,priority_score:3.6},auth,role('mechanic'));
}
