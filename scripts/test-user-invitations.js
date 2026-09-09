'use strict';

require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const adminToken = `invite-admin-${crypto.randomBytes(24).toString('base64url')}`;
const adminHash = crypto.createHash('sha256').update(adminToken).digest('hex');
const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;
const email = `invited-${crypto.randomBytes(8).toString('hex')}@example.invalid`;
const password = `Valid-Invite-${crypto.randomBytes(12).toString('base64url')}`;
let profileId;

async function call(path, options = {}, expected = 200, cookie = `wamy_session=${adminToken}`) {
  const response = await fetch(baseUrl + path, { ...options, headers: {
    ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', ...(options.headers || {})
  } });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, expected, `${path}: ${response.status} ${(body && body.message) || ''}`);
  return { body, response };
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const admin = (await client.query(`select id from profiles where role='admin' and status='active' and deleted_at is null limit 1`)).rows[0];
    assert.ok(admin);
    await client.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`, [adminHash,admin.id]);
    const invited = (await call('/api/profiles/invite', { method: 'POST', body: JSON.stringify({
      name: 'مستخدم دعوة اختباري', email, position: 'منسق', org: 'wamy', role: 'user',
      department: 'الإعلام', team: 'الفريق الرقمي', data_scope: 'my_team',
      permissions: { 'Dashboard.View': true, 'Tasks.View': true, 'Tasks.Create': true, 'Tasks.Assign': true, 'Reports.View': true, 'Reports.Export': true }
    }) }, 201)).body;
    profileId = invited.user.id;
    assert.ok(invited.invitation_url.startsWith('http'));
    const token = new URL(invited.invitation_url).searchParams.get('invite');
    assert.ok(token && token.length > 30);
    const stored = (await client.query(
      `select p.status,p.permissions,p.department,p.team,p.data_scope,p.password_hash,i.token_hash from profiles p join user_invitations i on i.profile_id=p.id where p.id=$1`, [profileId]
    )).rows[0];
    assert.equal(stored.status, 'pending');
    assert.equal(stored.permissions['Tasks.Create'], true);
    assert.equal(stored.data_scope, 'my_team');
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.token_hash, crypto.createHash('sha256').update(token).digest('hex'));

    const preview = (await call(`/api/auth/invitations/${encodeURIComponent(token)}`, {}, 200, null)).body;
    assert.equal(preview.email, email);
    const accepted = await call(`/api/auth/invitations/${encodeURIComponent(token)}/accept`, {
      method: 'POST', body: JSON.stringify({ password })
    }, 200, null);
    assert.equal(accepted.body.user.status, 'active');
    assert.match(accepted.response.headers.get('set-cookie') || '', /wamy_session=/);
    await call(`/api/auth/invitations/${encodeURIComponent(token)}`, {}, 404, null);
    const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email,password }) }, 200, null);
    assert.ok(login.body.session.user.id === profileId);
    console.log('PASS  admin-created user, hashed one-time invitation, assigned permissions, activation, and login');
  } finally {
    await client.query(`set app.allow_audit_mutation='on'`).catch(() => {});
    if (profileId) {
      await client.query(`delete from activity_log where entity_table='profiles' and entity_id=$1`, [profileId]).catch(() => {});
      await client.query('delete from profiles where id=$1', [profileId]).catch(() => {});
    }
    await client.query('delete from sessions where token_hash=$1', [adminHash]).catch(() => {});
    await client.end();
  }
})().catch(error => { console.error('FAIL ', error.message); process.exit(1); });
