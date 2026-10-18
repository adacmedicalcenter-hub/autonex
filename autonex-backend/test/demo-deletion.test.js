import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';import fs from 'node:fs/promises';import assert from 'node:assert/strict';import {grantWelcomeCredit,reserveFee,releaseAllUnreleasedFees} from '../src/services/feeService.js';
const {deleteOriginalDemos}=await import('../scripts/delete-original-demos.js');
await test('Original demo deletion preserves real admin and detached reporting history',async()=>{
const db=new PGlite();await db.waitReady;for(const n of (await fs.readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.exec(await fs.readFile('migrations/'+n,'utf8'));
for(const id of [1,2,3,4,5,7,8,9,10,11,12,13,14]){await db.query('INSERT INTO users(id,full_name,phone_number,user_type,password_hash,is_demo,is_admin) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,'Test '+id,id===14?'+237681462720':'+2376900000'+String(id).padStart(2,'0'),id===2?'mechanic':'driver','unused',id!==14,[4,14].includes(id)]);await grantWelcomeCredit(db,id);}
const r=(await db.query("INSERT INTO repair_requests(driver_id,title,location) VALUES(1,'Test task','Douala') RETURNING id")).rows[0];await reserveFee(1,r.id,'driver',10,db);await reserveFee(2,r.id,'mechanic',10,db);
await releaseAllUnreleasedFees(r.id,'Retired demo fixture',db);
await db.query("UPDATE repair_requests SET status='cancelled' WHERE id=$1",[r.id]);
await db.query("UPDATE users SET is_active=FALSE,is_admin=FALSE,phone_number='demo-archived-'||id WHERE id<>14");
await db.query('BEGIN');const deleted=await deleteOriginalDemos(db);await db.query('COMMIT');assert.equal(deleted.deleted,12);assert.equal((await db.query('SELECT COUNT(*)::int n FROM users')).rows[0].n,1);const hist=(await db.query("SELECT details FROM admin_audit WHERE action='deleted_demo_reporting_history'")).rows[0].details;assert.equal(hist.connection_credit_transactions.filter(t=>t.transaction_type==='welcome').length,12);assert.equal(hist.repair_requests.length,1);assert.equal((await db.query('SELECT * FROM connection_credit_transactions WHERE user_id=14')).rows.length,1);await db.query('BEGIN');assert.equal((await deleteOriginalDemos(db)).alreadyDeleted,true);await db.query('COMMIT');console.log('PASS: actual deletion, real admin ledger retained, demo reporting snapshot retained, repeat harmless');await db.close();

});
