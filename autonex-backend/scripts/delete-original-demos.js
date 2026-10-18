import pool from '../src/database/db.js';

export async function deleteOriginalDemos(c){
 const ids=[1,2,3,4,5,7,8,9,10,11,12,13];
 const quote=s=>'"'+s.replace(/"/g,'""')+'"';
 const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
 await c.query('LOCK TABLE '+tables.map(quote).join(',')+' IN SHARE ROW EXCLUSIVE MODE');
 const owner=(await c.query('SELECT is_admin,is_demo,is_active FROM users WHERE id=14 AND phone_number=$1',['+237681462720'])).rows[0];
 if(!owner?.is_admin||owner.is_demo||!owner.is_active)throw new Error('Real administrator verification failed');
 const users=(await c.query('SELECT id,user_type,is_demo,is_active,phone_number FROM users WHERE id=ANY($1::int[]) ORDER BY id',[ids])).rows;
 if(!users.length)return {alreadyDeleted:true};
 if(users.length!==12||users.some(u=>!u.is_demo||u.is_active||u.phone_number!=='demo-archived-'+u.id))throw new Error('Expected exactly twelve retired demo accounts; stopped');
 if((await c.query("SELECT id FROM connection_credit_reservations WHERE user_id=ANY($1::int[]) AND status='reserved'",[ids])).rows.length)throw new Error('Unreleased credit reservations; stopped');
 await c.query('CREATE TEMP TABLE cleanup_rows(table_name TEXT,row_tid TEXT,PRIMARY KEY(table_name,row_tid)) ON COMMIT DROP');
 await c.query("INSERT INTO cleanup_rows SELECT 'users',ctid::text FROM users WHERE id=ANY($1::int[])",[ids]);
 const edges=(await c.query(`SELECT child.relname AS child,parent.relname AS parent,ca.attname AS child_col,pa.attname AS parent_col
 FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=child.relnamespace
 JOIN pg_class parent ON parent.oid=fk.confrelid JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=fk.conkey[1]
 JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=fk.confkey[1]
 WHERE fk.contype='f' AND ns.nspname='public' AND array_length(fk.conkey,1)=1`)).rows;
 let changed=true;
 while(changed){changed=false;for(const e of edges){const result=await c.query(`INSERT INTO cleanup_rows SELECT $2,ch.ctid::text FROM ${quote(e.child)} ch JOIN ${quote(e.parent)} p ON ch.${quote(e.child_col)}=p.${quote(e.parent_col)} JOIN cleanup_rows cr ON cr.table_name=$1 AND cr.row_tid=p.ctid::text ON CONFLICT DO NOTHING`,[e.parent,e.child]);if(result.rowCount)changed=true;}}
 // Never delete another participant's account/activity through an incidental link.
 for(const e of edges.filter(e=>e.parent==='users'&&!['admin_id','created_by','reviewed_by','resolved_by'].includes(e.child_col))){
  const conflict=await c.query(`SELECT 1 FROM ${quote(e.child)} t JOIN cleanup_rows cr ON cr.table_name=$1 AND cr.row_tid=t.ctid::text WHERE t.${quote(e.child_col)} IS NOT NULL AND NOT(t.${quote(e.child_col)}=ANY($2::int[])) LIMIT 1`,[e.child,ids]);
  if(conflict.rows.length)throw new Error('A linked record belongs to a real account; stopped');
 }
 const fields={repair_requests:['id','driver_id','status','created_at'],journeys:['id','connection_reference','driver_id','mechanic_id','status','created_at'],connection_credit_transactions:['id','user_id','connection_reference','transaction_type','amount','balance_before','balance_after','source','reference_id','status','created_at'],connection_credit_purchases:['reference','user_id','package_id','amount_xaf','credits','provider','status','created_at'],wallet_transactions:['id','user_id','transaction_type','amount','balance_before','balance_after','created_at']};
 const history={label:'Deleted original demo accounts — test data, not live customers',accounts:users.map(({id,user_type})=>({id,user_type})),deletedAt:new Date().toISOString()};
 for(const [table,columns] of Object.entries(fields)){history[table]=(await c.query(`SELECT ${columns.map(x=>'t.'+quote(x)).join(',')} FROM ${quote(table)} t JOIN cleanup_rows cr ON cr.table_name=$1 AND cr.row_tid=t.ctid::text`,[table])).rows;}
 // Delete leaf tables first so no historical record is lost before its snapshot.
 const order=[],visiting=new Set(),done=new Set();
 function visit(table){if(done.has(table))return;if(visiting.has(table))throw new Error('Unexpected dependency cycle; stopped');visiting.add(table);for(const e of edges.filter(e=>e.parent===table&&e.child!==table))visit(e.child);visiting.delete(table);done.add(table);order.push(table);}
 visit('users');
 for(const table of order)await c.query(`DELETE FROM ${quote(table)} WHERE ctid::text IN (SELECT row_tid FROM cleanup_rows WHERE table_name=$1)`,[table]);
 // The earlier archival audit retained demo names and phone numbers. Replace it
 // with the identity-free reporting snapshot rather than retaining those details.
 await c.query("DELETE FROM admin_audit WHERE action='archive_original_demo_accounts'");
 await c.query("INSERT INTO admin_audit(admin_id,action,details) VALUES(14,'deleted_demo_reporting_history',$1)",[JSON.stringify(history)]);
 return {deleted:12,realAdminPreserved:true,reportingHistoryPreserved:true};
}
if(process.argv[1]?.endsWith('/delete-original-demos.js')&&process.argv.includes('--execute')){
 const c=await pool.connect();try{await c.query('BEGIN');const result=await deleteOriginalDemos(c);await c.query('COMMIT');console.log(JSON.stringify(result));}catch(e){await c.query('ROLLBACK');console.error('No changes committed:',e.message);process.exitCode=1;}finally{c.release();await pool.end();}
}
