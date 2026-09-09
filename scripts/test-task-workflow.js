'use strict';

require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const token = `task-workflow-${crypto.randomBytes(24).toString('base64url')}`;
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const baseUrl = `http://127.0.0.1:${process.env.PORT || 5173}`;
const testEmail = suffix => `task-workflow-${suffix}-${crypto.randomBytes(6).toString('hex')}@example.invalid`;
const dateOnly = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10);
let taskId;
let legacyTaskId;
const profileIds = [];

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, {
    ...options,
    headers: { Cookie: `wamy_session=${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${path}: ${response.status} ${(body && body.message) || ''}`);
  return body;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const admin = (await client.query(
      `select id,name from profiles where role='admin' and status='active' and deleted_at is null order by created_at limit 1`
    )).rows[0];
    assert.ok(admin, 'An active administrator is required.');
    const linked = (await client.query(
      `select p.id as project_id,p.org,i.id as plan_item_id,i.planned_start,i.planned_end
         from projects p join master_plan_items i on i.project_id=p.id
        where p.deleted_at is null and i.deleted_at is null and i.planned_start is not null and i.planned_end is not null
        order by p.code,i.external_id limit 1`
    )).rows[0];
    assert.ok(linked, 'A dated master-plan item is required.');

    for (const org of [linked.org, linked.org === 'wamy' ? 'imaan' : 'wamy']) {
      const inserted = (await client.query(
        `insert into profiles(name,email,password_hash,role,org,status,permissions)
         values($1,$2,'test-only','user',$3,'active','{}'::jsonb) returning id`,
        [`موظف اختبار ${org}`,testEmail(org),org]
      )).rows[0];
      profileIds.push(inserted.id);
    }
    await client.query(`insert into sessions(token_hash,user_id,expires_at) values($1,$2,now()+interval '10 minutes')`, [tokenHash,admin.id]);

    const start = `${dateOnly(linked.planned_start)}T06:00:00.000Z`;
    const baselineDue = new Date(`${dateOnly(linked.planned_end)}T14:00:00.000Z`);
    const alteredDue = new Date(baselineDue.getTime() + 2 * 86400000).toISOString();
    const payload = {
      project_id: linked.project_id, plan_item_id: linked.plan_item_id,
      title: `اختبار تسلسل المهمة ${crypto.randomBytes(4).toString('hex')}`,
      description: 'وصف تقني للاختبار', goal: 'التحقق من دورة إنشاء المهمة',
      required_outputs: 'مخرج اختباري موثق', priority: 'high', notes: 'تعليمات الاختبار',
      scheduled_start_at: start, scheduled_due_at: alteredDue,
      planned_start: start.slice(0,10), due_date: alteredDue.slice(0,10), active_duration: 3,
      status: 'not_started', progress: 0, assignee_ids: [admin.id,profileIds[0]],
      schedule_change_reason: 'اختبار توثيق الانحراف عن التزمين الأصلي'
    };
    const created = await request('/api/tasks', { method: 'POST', body: JSON.stringify(payload) }, 201);
    taskId = created.id;
    assert.equal(created.project_id, linked.project_id);
    assert.equal(created.plan_item_id, linked.plan_item_id);
    assert.equal(created.org, linked.org);

    const tasks = await request('/api/tasks');
    const listed = tasks.find(task => task.id === taskId);
    assert.deepEqual(new Set(listed.assignee_ids), new Set([admin.id,profileIds[0]]));

    const initialHistory = await request(`/api/tasks/${taskId}/schedule-history`);
    assert.equal(initialHistory.length, 1);
    assert.equal(initialHistory[0].changed_by, admin.id);
    assert.equal(initialHistory[0].changed_by_name, admin.name);
    assert.equal(initialHistory[0].change_reason, payload.schedule_change_reason);
    assert.ok(initialHistory[0].baseline_start_at && initialHistory[0].baseline_due_at);

    const fullEdit = await request(`/api/tasks/${taskId}`, {
      method: 'PATCH', headers: { 'If-Match': `"${created.updated_at}"` },
      body: JSON.stringify({ ...payload, product_id: null, schedule_change_reason: undefined })
    });
    assert.equal(fullEdit.length, 1);
    const noChangeHistory = await request(`/api/tasks/${taskId}/schedule-history`);
    assert.equal(noChangeHistory.length, 1, 'An unchanged schedule must not create a false history entry.');

    const rejected = await request('/api/tasks', { method: 'POST', body: JSON.stringify({ ...payload,
      title: `${payload.title} جهة خاطئة`, assignee_ids: [profileIds[1]]
    }) }, 400);
    assert.equal(rejected.code, 'INVALID_INPUT');

    const revisedDue = new Date(new Date(alteredDue).getTime() + 86400000).toISOString();
    await request(`/api/tasks/${taskId}`, {
      method: 'PATCH', headers: { 'If-Match': `"${fullEdit[0].updated_at}"` },
      body: JSON.stringify({ scheduled_due_at: revisedDue, due_date: revisedDue.slice(0,10),
        schedule_change_reason: 'تمديد معتمد للاختبار' })
    });
    const history = await request(`/api/tasks/${taskId}/schedule-history`);
    assert.equal(history.length, 2);
    assert.equal(history[0].change_reason, 'تمديد معتمد للاختبار');
    assert.equal(new Date(history[0].previous_due_at).toISOString(), alteredDue);
    assert.equal(new Date(history[0].new_due_at).toISOString(), revisedDue);

    const unchanged = (await client.query(
      'select planned_start,planned_end from master_plan_items where id=$1', [linked.plan_item_id]
    )).rows[0];
    assert.equal(dateOnly(unchanged.planned_start), dateOnly(linked.planned_start));
    assert.equal(dateOnly(unchanged.planned_end), dateOnly(linked.planned_end));

    const legacy = (await client.query(
      `insert into tasks(project_id,title,description,org,assignee_id,priority,status,progress,planned_start,due_date,created_by)
       values($1,$2,'مهمة مستوردة قديمة',$3,$4,'normal','not_started',0,$5,$6,$4) returning id,updated_at`,
      [linked.project_id,`اختبار ترقية مهمة قديمة ${crypto.randomBytes(4).toString('hex')}`,linked.org,admin.id,dateOnly(linked.planned_start),dateOnly(linked.planned_end)]
    )).rows[0];
    legacyTaskId = legacy.id;
    await client.query('insert into task_assignees(task_id,user_id,assigned_by) values($1,$2,$2)', [legacyTaskId,admin.id]);
    const invalidPriority = await request(`/api/tasks/${legacyTaskId}`, {
      method: 'PATCH', headers: { 'If-Match': `"${legacy.updated_at.toISOString()}"` },
      body: JSON.stringify({ priority: null })
    }, 400);
    assert.equal(invalidPriority.code, 'INVALID_INPUT');
    const upgraded = await request(`/api/tasks/${legacyTaskId}`, {
      method: 'PATCH', headers: { 'If-Match': `"${legacy.updated_at.toISOString()}"` },
      body: JSON.stringify({ ...payload, title: legacy.title, product_id: null, assignee_ids: [admin.id],
        schedule_change_reason: 'ربط المهمة القديمة بالخطة الرئيسية' })
    });
    assert.equal(upgraded[0].project_id, linked.project_id);
    assert.equal(upgraded[0].plan_item_id, linked.plan_item_id);
    assert.equal((await request(`/api/tasks/${legacyTaskId}/schedule-history`)).length, 1);
    console.log('PASS  project → product → task → multiple assignees, immutable baseline, and schedule history');
  } finally {
    await client.query(`set app.allow_audit_mutation='on'`).catch(() => {});
    if (taskId) {
      await client.query(`delete from activity_log where entity_table='tasks' and entity_id=$1`, [taskId]).catch(() => {});
      await client.query('delete from tasks where id=$1', [taskId]).catch(() => {});
    }
    if (legacyTaskId) {
      await client.query(`delete from activity_log where entity_table='tasks' and entity_id=$1`, [legacyTaskId]).catch(() => {});
      await client.query('delete from tasks where id=$1', [legacyTaskId]).catch(() => {});
    }
    await client.query('delete from sessions where token_hash=$1', [tokenHash]).catch(() => {});
    for (const id of profileIds) await client.query('delete from profiles where id=$1', [id]).catch(() => {});
    await client.end();
  }
})().catch(error => { console.error('FAIL ', error.message); process.exit(1); });
