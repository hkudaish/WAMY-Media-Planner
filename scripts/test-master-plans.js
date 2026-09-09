'use strict';

require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const token = 'master-test-' + crypto.randomBytes(20).toString('base64url');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;
let taskId;

async function api(path, options = {}) {
  const response = await fetch(baseUrl + path, { ...options, headers: { Cookie: `wamy_session=${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${path}: ${response.status} ${(body && body.message) || ''}`);
  return body;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let admin;
  try {
    const counts = await client.query(
      `select p.code,count(i.id)::int as items from projects p left join master_plan_items i on i.project_id=p.id and i.deleted_at is null
        where p.deleted_at is null group by p.id,p.code order by p.code`
    );
    assert.deepEqual(counts.rows.map(row => [row.code, row.items]), [['STR-COMM-01', 73], ['WEB-REBUILD-01', 51]]);
    admin = (await client.query(`select id from profiles where role='admin' and status='active' and deleted_at is null limit 1`)).rows[0];
    assert.ok(admin);
    await client.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`, [tokenHash, admin.id]);
    const projects = await api('/api/projects');
    const items = await api('/api/master-plan-items');
    assert.equal(projects.length, 2);
    assert.equal(items.length, 124);
    const item = items.find(candidate => candidate.project_id === projects[0].id);
    const created = await api('/api/tasks', { method: 'POST', body: JSON.stringify({
      project_id: projects[0].id, plan_item_id: item.id, title: `اختبار ربط ${crypto.randomBytes(5).toString('hex')}`,
      org: 'wamy', assignee_id: admin.id, assignee_ids: [admin.id], required_outputs: 'نتيجة اختبار الربط',
      priority: 'normal', status: 'not_started', progress: 0, planned_start: '2025-12-31', due_date: '2026-01-01',
      scheduled_start_at: '2025-12-31T06:00:00.000Z', scheduled_due_at: '2026-01-01T14:00:00.000Z'
    }) });
    taskId = created.id;
    assert.equal(created.project_id, projects[0].id);
    assert.equal(created.plan_item_id, item.id);
    const alerts = await api('/api/alerts');
    assert.ok(alerts.some(alert => alert.task_id === taskId && alert.type === 'overdue'));
    console.log('PASS  2 independent projects, 124 baseline items, task assignment link, and execution alerts');
  } finally {
    await client.query(`set app.allow_audit_mutation='on'`).catch(() => {});
    if (taskId) {
      await client.query(`delete from activity_log where entity_table='tasks' and entity_id=$1`, [taskId]).catch(() => {});
      await client.query('delete from tasks where id=$1', [taskId]).catch(() => {});
    }
    await client.query('delete from sessions where token_hash=$1', [tokenHash]).catch(() => {});
    await client.end();
  }
})().catch(error => { console.error('FAIL ', error.message); process.exit(1); });
