'use strict';

require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;
const marker = crypto.randomBytes(8).toString('hex');
const token = crypto.randomBytes(32).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
let userId;
let ownProductId;
let otherProductId;
let ownTaskId;
let createdProjectIds = [];

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { Cookie: `wamy_session=${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('base64url'), 12);
    userId = (await client.query(
      `insert into profiles(name,email,password_hash,role,org,status,permissions)
       values($1,$2,$3,'user','imaan','active',default_permissions()) returning id`,
      [`Security Test ${marker}`, `security-${marker}@example.test`, passwordHash]
    )).rows[0].id;
    ownProductId = (await client.query(
      `insert into products(code,name,org,status,allow_multiple_tasks) values($1,$2,'imaan','in_progress',true) returning id`,
      [`SEC-${marker}`, `Security test ${marker}`]
    )).rows[0].id;
    otherProductId = (await client.query(
      `insert into products(code,name,org,status,allow_multiple_tasks) values($1,$2,'wamy','in_progress',true) returning id`,
      [`OTH-${marker}`, `Other org ${marker}`]
    )).rows[0].id;
    createdProjectIds = [];
    let imaanProj = (await client.query(`select id from projects where org='imaan' and deleted_at is null limit 1`)).rows[0];
    if (!imaanProj) {
      imaanProj = (await client.query(`insert into projects(code,name,org,status) values($1,$2,'imaan','active') returning id`, [`SEC-PRJ-${marker}`, `Security Project ${marker}`])).rows[0];
      createdProjectIds.push(imaanProj.id);
    }
    let wamyProj = (await client.query(`select id from projects where org='wamy' and deleted_at is null limit 1`)).rows[0];
    if (!wamyProj) {
      wamyProj = (await client.query(`insert into projects(code,name,org,status) values($1,$2,'wamy','active') returning id`, [`OTH-PRJ-${marker}`, `Other Project ${marker}`])).rows[0];
      createdProjectIds.push(wamyProj.id);
    }

    ownTaskId = (await client.query(
      `insert into tasks(project_id,product_id,title,org,assignee_id,due_date) values($1,$2,$3,'imaan',$4,current_date+1) returning id`,
      [imaanProj.id, ownProductId, `Own task ${marker}`, userId]
    )).rows[0].id;
    const otherTaskId = (await client.query(
      `insert into tasks(project_id,product_id,title,org,due_date) values($1,$2,$3,'wamy',current_date+1) returning id`,
      [wamyProj.id, otherProductId, `Other task ${marker}`]
    )).rows[0].id;
    await client.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`, [tokenHash, userId]);

    const listed = await request('/api/tasks');
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.some(task => task.id === ownTaskId), 'Assignee cannot see own task.');
    assert.ok(!listed.body.some(task => task.id === otherTaskId), 'Cross-organization task was disclosed.');

    const forbiddenField = await request(`/api/tasks/${ownTaskId}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'in_progress', assignee_id: null })
    });
    assert.equal(forbiddenField.response.status, 403, 'Assignee changed a protected field.');

    const allowedField = await request(`/api/tasks/${ownTaskId}`, {
      method: 'PATCH', body: JSON.stringify({ status: 'in_progress', progress: 25 })
    });
    assert.equal(allowedField.response.status, 200, 'Assignee could not update execution fields.');

    const currentVersion = allowedField.body[0].updated_at;
    const firstConcurrentEdit = await request(`/api/tasks/${ownTaskId}`, {
      method: 'PATCH', headers: { 'If-Match': `"${currentVersion}"` },
      body: JSON.stringify({ progress: 30 })
    });
    assert.equal(firstConcurrentEdit.response.status, 200, 'Version-aware task update failed.');
    const staleConcurrentEdit = await request(`/api/tasks/${ownTaskId}`, {
      method: 'PATCH', headers: { 'If-Match': `"${currentVersion}"` },
      body: JSON.stringify({ progress: 35 })
    });
    assert.equal(staleConcurrentEdit.response.status, 409, 'Stale concurrent edit overwrote newer task data.');
    assert.equal(staleConcurrentEdit.body.code, 'EDIT_CONFLICT');

    const forgedAudit = await request('/api/logs', { method: 'POST', body: JSON.stringify({ action: 'forged', type: 'AUTH' }) });
    assert.equal(forgedAudit.response.status, 405, 'Client-created audit event was accepted.');

    const crossOrigin = await request('/api/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(crossOrigin.response.status, 403, 'Cross-origin mutation was accepted.');

    const audit = await client.query(`select id from activity_log where actor_id=$1 and entity_id=$2 and type='UPDATE'`, [userId, ownTaskId]);
    assert.ok(audit.rowCount > 0, 'Server did not create an audit event.');
    await assert.rejects(client.query('delete from activity_log where id=$1', [audit.rows[0].id]), error => error.code === '42501');
    console.log('PASS  scoping, authorization, edit conflicts, origin checks, and immutable server auditing');
  } finally {
    await client.query(`set app.allow_audit_mutation='on'`).catch(() => {});
    if (userId) await client.query('delete from activity_log where actor_id=$1', [userId]).catch(() => {});
    await client.query('delete from sessions where token_hash=$1', [tokenHash]).catch(() => {});
    if (ownProductId || otherProductId) {
      await client.query('delete from products where id=any($1::uuid[])', [[ownProductId, otherProductId].filter(Boolean)]).catch(() => {});
    }
    if (createdProjectIds.length) {
      await client.query('delete from projects where id=any($1::uuid[])', [createdProjectIds]).catch(() => {});
    }
    if (userId) await client.query('delete from profiles where id=$1', [userId]).catch(() => {});
    await client.query("delete from projects where code like 'SEC-PRJ-%' or code like 'OTH-PRJ-%'").catch(() => {});
    await client.end();
  }
})().catch(error => {
  console.error('FAIL ', error.message);
  process.exit(1);
});
